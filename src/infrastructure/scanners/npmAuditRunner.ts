/**
 * Audits changed `package-lock.json` manifests for known-vulnerable dependencies via `npm audit`.
 *
 * This replaces the Python original's `pip-audit`: same idea (ask the package manager's own audit
 * command about the *lockfile* actually being shipped), different ecosystem. `npm audit` refuses to
 * run without a sibling `package.json` next to the lockfile, so one is materialized alongside it — the
 * PR's own if it was among the changed files, otherwise a minimal stub. The stub's content cannot
 * change the result: `--package-lock-only` means npm consults only the lockfile for what to audit; the
 * manifest just needs to exist so npm accepts the directory as a project. Unlike Semgrep, this scanner
 * queries the public npm registry advisory endpoint over the network, so it is optional and every
 * failure mode — timeout, a bad exit code, unparseable JSON — degrades to a `Diagnostic` naming the
 * offending manifest rather than throwing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import type { AnalysisContext, Analyzer } from "../../application/analyzers/base.ts";
import {
  type AnalyzerOutcome,
  type Diagnostic,
  makeOutcome,
  OutcomeStatus,
} from "../../domain/models/analysis.ts";
import {
  Category,
  Confidence,
  DiffSide,
  type Finding,
  makeFinding,
  Severity,
  SourceKind,
} from "../../domain/models/finding.ts";
import type { IdGenerator, SubprocessRunner, TempWorkspace } from "../../domain/ports/system.ts";
import { computeFingerprint } from "../../domain/services/fingerprint.ts";
import { resolveWithin } from "../fs/pathsafe.ts";
import {
  type NpmAuditFixAvailable,
  type NpmAuditVia,
  type NpmAuditVulnerability,
  parseNpmAuditOutput,
} from "./npmAuditOutput.ts";

const SOURCE = "npm-audit";
const DEFAULT_TIMEOUT_SECONDS = 60;
const MANIFEST_NAME = "package-lock.json";
/** `npm audit --package-lock-only` never reads this file's content, only that it exists. */
const STUB_PACKAGE_JSON = JSON.stringify({ name: "bicho-audit", version: "0.0.0" });
const IMPACT = "A dependency with a publicly known vulnerability would ship in this change.";

/** npm's five advisory severities, mapped onto ours; anything unrecognized reads as medium. */
const SEVERITY_MAP: Readonly<Record<string, Severity>> = {
  critical: Severity.CRITICAL,
  high: Severity.HIGH,
  moderate: Severity.MEDIUM,
  low: Severity.LOW,
  info: Severity.INFO,
};

/** What one manifest's audit contributed to the overall outcome. */
interface ManifestResult {
  readonly findings: readonly Finding[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Runs `npm audit` over each changed `package-lock.json` and maps advisories into `Finding`s.
 *
 * Every manifest in a PR is audited independently but they all share one temp workspace (separate
 * subdirectories), so a PR with several lockfiles pays for one sandbox, not N.
 */
export class NpmAuditScanner implements Analyzer {
  readonly #runner: SubprocessRunner;
  readonly #workspace: TempWorkspace;
  readonly #ids: IdGenerator;
  readonly #timeoutSeconds: number;

  constructor(options: {
    runner: SubprocessRunner;
    workspace: TempWorkspace;
    ids: IdGenerator;
    timeoutSeconds?: number;
  }) {
    this.#runner = options.runner;
    this.#workspace = options.workspace;
    this.#ids = options.ids;
    this.#timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  async analyze(context: AnalysisContext): Promise<AnalyzerOutcome> {
    const manifests = [...context.fileContents].filter(
      ([path]) => posix.basename(path) === MANIFEST_NAME,
    );
    if (manifests.length === 0) {
      return makeOutcome({ source: SOURCE, status: OutcomeStatus.ZERO_FINDINGS });
    }

    await using workspace = await this.#workspace.create();
    const findings: Finding[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const [path, content] of manifests) {
      const cwd = await this.#materialize(workspace.path, path, content, context.fileContents);
      const manifestResult = await this.#audit(cwd, path, content, context);
      findings.push(...manifestResult.findings);
      diagnostics.push(...manifestResult.diagnostics);
    }

    // OK beats any diagnostic; otherwise surface whichever manifest failed first, in scan order.
    const firstDiagnostic = diagnostics.at(0);
    const status =
      findings.length > 0
        ? OutcomeStatus.OK
        : (firstDiagnostic?.status ?? OutcomeStatus.ZERO_FINDINGS);

    return makeOutcome({ source: SOURCE, status, findings, diagnostics });
  }

  /** Write the lockfile and a sibling `package.json` into the workspace; return the directory. */
  async #materialize(
    workspacePath: string,
    manifestPath: string,
    manifestContent: string,
    fileContents: ReadonlyMap<string, string>,
  ): Promise<string> {
    const lockTarget = resolveWithin(workspacePath, manifestPath);
    const dir = dirname(lockTarget);
    await mkdir(dir, { recursive: true });
    await writeFile(lockTarget, manifestContent, "utf8");

    const siblingPath = posix.join(posix.dirname(manifestPath), "package.json");
    const siblingContent = fileContents.get(siblingPath) ?? STUB_PACKAGE_JSON;
    await writeFile(resolveWithin(workspacePath, siblingPath), siblingContent, "utf8");

    return dir;
  }

  async #audit(
    cwd: string,
    path: string,
    manifestContent: string,
    context: AnalysisContext,
  ): Promise<ManifestResult> {
    const result = await this.#runner.run(
      ["npm", "audit", "--package-lock-only", "--json", "--audit-level=low"],
      { timeoutSeconds: this.#timeoutSeconds, cwd },
    );

    if (result.timedOut) {
      return failure(OutcomeStatus.TIMEOUT, `npm audit timed out for ${path}`);
    }
    // npm audit's exit code doubles as its verdict: 0 = clean, 1 = vulnerabilities found. Both are a
    // successful run; any other code means the command itself failed.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const stderr = result.stderr.toString("utf8").trim();
      return failure(OutcomeStatus.ERROR, stderr || `npm audit failed for ${path}`);
    }

    const parsed = parseNpmAuditOutput(result.stdout.toString("utf8"));
    if (parsed === null) {
      return failure(OutcomeStatus.ERROR, `could not parse npm audit output for ${path}`);
    }

    const findings = Object.values(parsed.vulnerabilities).map((vulnerability) =>
      this.#toFinding(vulnerability, path, manifestContent, context),
    );
    return { findings, diagnostics: [] };
  }

  #toFinding(
    vulnerability: NpmAuditVulnerability,
    manifestPath: string,
    manifestContent: string,
    context: AnalysisContext,
  ): Finding {
    const advisory = firstAdvisory(vulnerability.via);
    const title = advisory?.title ?? "known vulnerability";
    const ruleKey = ruleKeyFor(advisory, vulnerability.name);
    const line = findPackageLine(manifestContent, vulnerability.name);

    return makeFinding({
      id: this.#ids.newId(),
      fingerprint: computeFingerprint({
        path: manifestPath,
        category: Category.DEPENDENCY,
        subcategory: ruleKey,
        ruleKey,
        enclosingSymbol: null,
        snippet: vulnerability.name,
      }),
      category: Category.DEPENDENCY,
      subcategory: ruleKey,
      severity: mapSeverity(vulnerability.severity),
      confidence: Confidence.HIGH,
      title: `${vulnerability.name}: ${title}`,
      explanation: explanationFor(vulnerability, advisory),
      impact: IMPACT,
      recommendation: recommendationFor(vulnerability.name, vulnerability.fixAvailable),
      path: manifestPath,
      startLine: line,
      endLine: line,
      diffSide: DiffSide.RIGHT,
      sourceKind: SourceKind.NPM_AUDIT,
      sourceName: SOURCE,
      headSha: context.headSha,
      language: context.language,
      framework: context.framework,
    });
  }
}

function failure(
  status: typeof OutcomeStatus.TIMEOUT | typeof OutcomeStatus.ERROR,
  message: string,
): ManifestResult {
  return { findings: [], diagnostics: [{ source: SOURCE, status, message }] };
}

function mapSeverity(raw: string): Severity {
  return SEVERITY_MAP[raw.toLowerCase()] ?? Severity.MEDIUM;
}

type AdvisoryObject = Exclude<NpmAuditVia, string>;

/** The first `via` entry that is an advisory object — the package this vulnerability originates at. */
function firstAdvisory(via: readonly NpmAuditVia[]): AdvisoryObject | null {
  for (const entry of via) {
    if (typeof entry !== "string") {
      return entry;
    }
  }
  return null;
}

/** The fingerprint/subcategory key: the advisory id when known, else the package name. */
function ruleKeyFor(advisory: AdvisoryObject | null, name: string): string {
  if (advisory === null || advisory.source === undefined) {
    return name;
  }
  return String(advisory.source);
}

/** Describe the advisory itself when known, otherwise name the chain this package was pulled in via. */
function explanationFor(
  vulnerability: NpmAuditVulnerability,
  advisory: AdvisoryObject | null,
): string {
  if (advisory === null) {
    const chain = vulnerability.via
      .filter((entry): entry is string => typeof entry === "string")
      .join(" > ");
    return `This is a transitive vulnerability, pulled in via ${chain}.`;
  }
  const title = advisory.title ?? "a known vulnerability";
  return advisory.url === undefined
    ? `npm audit reported ${title} in this dependency.`
    : `npm audit reported ${title} in this dependency (${advisory.url}).`;
}

/** Name the concrete upgrade target when npm knows one, otherwise a generic nudge to patch. */
function recommendationFor(name: string, fixAvailable: NpmAuditFixAvailable | undefined): string {
  return typeof fixAvailable === "object"
    ? `Upgrade ${name} to ${fixAvailable.name}@${fixAvailable.version}, which resolves this advisory.`
    : `Upgrade ${name} to a patched version.`;
}

/**
 * Find the 1-based line where `name` first appears in a `package-lock.json`, to anchor a finding.
 *
 * Handles both lockfile layouts: v2/v3's flat `"node_modules/<name>": {…}` entries and v1's nested
 * `"<name>": {…}` entries. Falls back to line 1 (the manifest itself) so a finding is always
 * anchorable rather than dropped when the package cannot be located textually.
 */
export function findPackageLine(manifestContent: string, name: string): number {
  const nodeModulesNeedle = `"node_modules/${name}"`;
  const nameNeedle = `"${name}":`;
  const lines = manifestContent.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.includes(nodeModulesNeedle) || line.trim().startsWith(nameNeedle)) {
      return index + 1;
    }
  }
  return 1;
}

/** Build an {@link NpmAuditScanner}; the composition root's single entry point for wiring one up. */
export function buildNpmAuditScanner(options: {
  runner: SubprocessRunner;
  workspace: TempWorkspace;
  ids: IdGenerator;
  timeoutSeconds?: number;
}): NpmAuditScanner {
  return new NpmAuditScanner(options);
}
