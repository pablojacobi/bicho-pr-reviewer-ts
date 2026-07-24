/**
 * Runs Semgrep over a PR's changed files and normalizes matches into domain `Finding`s.
 *
 * The repository is never cloned and nothing in it is ever executed: only the *content* of the
 * in-scope changed files (already fetched at the head SHA by an earlier graph node) is materialized
 * into an isolated temp workspace at sanitized paths, and Semgrep runs there as a pattern matcher over
 * that scratch copy — with no shell, a hard timeout, and network/metrics disabled. As a scanner node in
 * a parallel LangGraph superstep, `analyze` must never throw: every failure (timeout, non-zero exit,
 * unparseable JSON) degrades to an `AnalyzerOutcome` carrying a `Diagnostic` instead.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AnalysisContext, Analyzer } from "../../application/analyzers/base.ts";
import { type AnalyzerOutcome, makeOutcome, OutcomeStatus } from "../../domain/models/analysis.ts";
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
import { parseSemgrepOutput, type SemgrepResult } from "./semgrepOutput.ts";

const SOURCE = "semgrep";
const DEFAULT_CONFIG = "resources/semgrep";
const DEFAULT_TIMEOUT_SECONDS = 60;

/** Semgrep's three match severities, mapped onto ours; anything unrecognized reads as the lowest. */
const SEVERITY_MAP: Readonly<Record<string, Severity>> = {
  ERROR: Severity.HIGH,
  WARNING: Severity.MEDIUM,
  INFO: Severity.LOW,
};

/**
 * Runs `semgrep scan` in an isolated workspace and maps its matches into `Finding`s.
 *
 * One instance is reused across analyses; `config`/`timeoutSeconds` default to the project's bundled
 * ruleset and a one-minute budget, matching {@link ScannerSettings} in `src/config/settings.ts`.
 */
export class SemgrepScanner implements Analyzer {
  readonly #runner: SubprocessRunner;
  readonly #workspace: TempWorkspace;
  readonly #ids: IdGenerator;
  readonly #config: string;
  readonly #timeoutSeconds: number;

  constructor(options: {
    runner: SubprocessRunner;
    workspace: TempWorkspace;
    ids: IdGenerator;
    config?: string;
    timeoutSeconds?: number;
  }) {
    this.#runner = options.runner;
    this.#workspace = options.workspace;
    this.#ids = options.ids;
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  async analyze(context: AnalysisContext): Promise<AnalyzerOutcome> {
    // Nothing to scan and nothing to sandbox: skip standing up a workspace and a process entirely.
    if (context.fileContents.size === 0) {
      return makeOutcome({ source: SOURCE, status: OutcomeStatus.ZERO_FINDINGS });
    }

    await using workspace = await this.#workspace.create();
    for (const [path, content] of context.fileContents) {
      const target = resolveWithin(workspace.path, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }

    const result = await this.#runner.run(
      [
        "semgrep",
        "scan",
        "--config",
        resolve(this.#config),
        "--json",
        "--quiet",
        "--disable-version-check",
        "--metrics=off",
        "--no-git-ignore",
        "--timeout",
        String(Math.trunc(this.#timeoutSeconds)),
        ".",
      ],
      { timeoutSeconds: this.#timeoutSeconds, cwd: workspace.path },
    );

    if (result.timedOut) {
      return this.#degraded(OutcomeStatus.TIMEOUT, "semgrep timed out");
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      return this.#degraded(OutcomeStatus.ERROR, stderr || "semgrep exited non-zero");
    }

    const parsed = parseSemgrepOutput(result.stdout.toString("utf8"));
    if (parsed === null) {
      return this.#degraded(OutcomeStatus.ERROR, "could not parse semgrep JSON output");
    }

    const findings = parsed.results.map((raw) => this.#toFinding(raw, context));
    return makeOutcome({
      source: SOURCE,
      status: findings.length > 0 ? OutcomeStatus.OK : OutcomeStatus.ZERO_FINDINGS,
      findings,
    });
  }

  #degraded(
    status: typeof OutcomeStatus.TIMEOUT | typeof OutcomeStatus.ERROR,
    message: string,
  ): AnalyzerOutcome {
    return makeOutcome({
      source: SOURCE,
      status,
      diagnostics: [{ source: SOURCE, status, message }],
    });
  }

  #toFinding(raw: SemgrepResult, context: AnalysisContext): Finding {
    const path = stripLeadingDotSlash(raw.path);
    const rule = ruleName(raw.check_id);
    const severity = mapSeverity(raw.extra.severity);
    return makeFinding({
      id: this.#ids.newId(),
      fingerprint: computeFingerprint({
        path,
        category: Category.SECURITY,
        subcategory: rule,
        ruleKey: rule,
        enclosingSymbol: null,
        snippet: "",
      }),
      category: Category.SECURITY,
      subcategory: rule,
      severity,
      confidence: Confidence.HIGH,
      title: `Semgrep: ${rule}`,
      explanation: raw.extra.message || "A Semgrep rule matched this code.",
      impact: "A static-analysis rule flagged a pattern introduced by this change.",
      recommendation: "Review the flagged pattern and remediate as the rule advises.",
      path,
      startLine: raw.start.line,
      endLine: Math.max(raw.start.line, raw.end.line),
      diffSide: DiffSide.RIGHT,
      sourceKind: SourceKind.SEMGREP,
      sourceName: SOURCE,
      headSha: context.headSha,
      language: context.language,
      framework: context.framework,
    });
  }
}

/** Semgrep reports paths relative to the scan root, sometimes prefixed with `./`; drop it. */
function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** Semgrep namespaces a rule id by the ruleset file path (`typescript.security.eval-use`); the rule's own name is the last segment. */
function ruleName(checkId: string): string {
  return checkId.replace(/^.*\./, "");
}

function mapSeverity(raw: string | undefined): Severity {
  return SEVERITY_MAP[(raw ?? "").toUpperCase()] ?? Severity.LOW;
}

/** Build a {@link SemgrepScanner}; the composition root's single entry point for wiring one up. */
export function buildSemgrepScanner(options: {
  runner: SubprocessRunner;
  workspace: TempWorkspace;
  ids: IdGenerator;
  config?: string;
  timeoutSeconds?: number;
}): SemgrepScanner {
  return new SemgrepScanner(options);
}
