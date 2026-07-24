import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../src/application/analyzers/base.ts";
import { OutcomeStatus } from "../../src/domain/models/analysis.ts";
import { Category, Confidence, DiffSide, SourceKind } from "../../src/domain/models/finding.ts";
import type {
  ProcessResult,
  SubprocessRunner,
  TempWorkspace,
} from "../../src/domain/ports/system.ts";
import { computeFingerprint } from "../../src/domain/services/fingerprint.ts";
import { TempWorkspaceFactory } from "../../src/infrastructure/fs/workspace.ts";
import { SequentialIdGenerator } from "../../src/infrastructure/ids.ts";
import { FakeSubprocessRunner, processResult } from "../../src/infrastructure/process/fake.ts";
import {
  buildNpmAuditScanner,
  findPackageLine,
  NpmAuditScanner,
} from "../../src/infrastructure/scanners/npmAuditRunner.ts";
import { DummyAdapter } from "../helpers/dummyAdapter.ts";

/** A {@link TempWorkspace} that fails the test if it is ever asked to create a directory. */
class PoisonedWorkspace implements TempWorkspace {
  async create(): Promise<never> {
    throw new Error("workspace must not be created when there is nothing to audit");
  }
}

/**
 * Wraps a {@link SubprocessRunner}, reading back the sibling `package.json` an audit call ran
 * against — the only way to observe what the scanner materialized, since the workspace is gone by
 * the time `analyze` resolves.
 */
class SiblingRecordingRunner implements SubprocessRunner {
  readonly siblingPackageJsonContents: string[] = [];
  readonly #inner: SubprocessRunner;

  constructor(inner: SubprocessRunner) {
    this.#inner = inner;
  }

  async run(
    command: readonly string[],
    options: { timeoutSeconds: number; cwd?: string },
  ): Promise<ProcessResult> {
    if (options.cwd !== undefined) {
      this.siblingPackageJsonContents.push(
        await readFile(join(options.cwd, "package.json"), "utf8"),
      );
    }
    return this.#inner.run(command, options);
  }
}

function makeContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    diff: { files: [] },
    headSha: "headsha",
    language: "typescript",
    framework: null,
    correlationId: "corr-1",
    adapter: new DummyAdapter(),
    fileContents: new Map(),
    ...overrides,
  };
}

function npmAuditStdout(vulnerabilities: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ vulnerabilities }));
}

/** A v2/v3-style lockfile: flat `node_modules/<name>` entries. `lodash` is on line 6. */
const LOCKFILE_FLAT = [
  "{",
  '  "name": "app",',
  '  "lockfileVersion": 3,',
  '  "packages": {',
  '    "": { "name": "app", "version": "1.0.0" },',
  '    "node_modules/lodash": { "version": "4.17.15" }',
  "  }",
  "}",
  "",
].join("\n");

/** A v1-style lockfile: nested `"<name>": {…}` entries. `lodash` is on line 4. */
const LOCKFILE_NESTED = [
  "{",
  '  "name": "app",',
  '  "dependencies": {',
  '    "lodash": {',
  '      "version": "4.17.15"',
  "    }",
  "  }",
  "}",
  "",
].join("\n");

/** A lockfile that never mentions the packages these tests query. */
const LOCKFILE_NO_MATCH = ["{", '  "name": "app",', '  "lockfileVersion": 3', "}", ""].join("\n");

describe("findPackageLine", () => {
  it("finds a flat v2/v3 node_modules entry", () => {
    expect(findPackageLine(LOCKFILE_FLAT, "lodash")).toBe(6);
  });

  it("finds a nested v1 dependency entry", () => {
    expect(findPackageLine(LOCKFILE_NESTED, "lodash")).toBe(4);
  });

  it("falls back to line 1 when the package cannot be located", () => {
    expect(findPackageLine(LOCKFILE_NO_MATCH, "lodash")).toBe(1);
  });
});

describe("NpmAuditScanner", () => {
  it("returns zero findings without creating a workspace when no package-lock.json changed", async () => {
    const runner = new FakeSubprocessRunner();
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new PoisonedWorkspace(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([
        ["src/app.ts", "code"],
        // Merely ending in the manifest name is not enough: the basename must match exactly.
        ["nested/foo-package-lock.json", "{}"],
      ]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome).toEqual({
      source: "npm-audit",
      status: OutcomeStatus.ZERO_FINDINGS,
      findings: [],
      diagnostics: [],
    });
    expect(runner.commands).toEqual([]);
  });

  it("builds the audit command and writes a stub package.json when the PR has none", async () => {
    const inner = new FakeSubprocessRunner(
      processResult({ exitCode: 0, stdout: npmAuditStdout({}) }),
    );
    const runner = new SiblingRecordingRunner(inner);
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome).toEqual({
      source: "npm-audit",
      status: OutcomeStatus.ZERO_FINDINGS,
      findings: [],
      diagnostics: [],
    });
    expect(inner.commands).toEqual([
      ["npm", "audit", "--package-lock-only", "--json", "--audit-level=low"],
    ]);
    expect(inner.cwds[0]).toContain("bicho-");
    expect(runner.siblingPackageJsonContents).toEqual(['{"name":"bicho-audit","version":"0.0.0"}']);
  });

  it("uses the PR's own package.json when it changed alongside the lockfile", async () => {
    const inner = new FakeSubprocessRunner(
      processResult({ exitCode: 0, stdout: npmAuditStdout({}) }),
    );
    const runner = new SiblingRecordingRunner(inner);
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([
        ["package-lock.json", LOCKFILE_NO_MATCH],
        ["package.json", '{"name":"my-app","version":"2.0.0"}'],
      ]),
    });

    await scanner.analyze(context);

    expect(runner.siblingPackageJsonContents).toEqual(['{"name":"my-app","version":"2.0.0"}']);
  });

  it("succeeds on exit code 1, npm's way of reporting vulnerabilities were found", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        exitCode: 1,
        stdout: npmAuditStdout({
          lodash: { name: "lodash", severity: "high", via: ["parent"] },
        }),
      }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_FLAT]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.OK);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.diagnostics).toEqual([]);
  });

  it("maps every field of a vulnerability with a direct advisory (an object in via)", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        exitCode: 1,
        stdout: npmAuditStdout({
          lodash: {
            name: "lodash",
            severity: "high",
            // A leading string plus a trailing advisory object: the first *object* must win, not
            // simply the first entry.
            via: [
              "intermediate-pkg",
              {
                source: 1093,
                name: "lodash",
                title: "Prototype Pollution",
                url: "https://example.com/advisories/1093",
                severity: "high",
              },
            ],
            range: "<4.17.19",
            fixAvailable: { name: "lodash", version: "4.17.21" },
          },
        }),
      }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_FLAT]]),
      headSha: "deadbeef",
      language: "typescript",
      framework: "react",
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.OK);
    expect(outcome.findings).toHaveLength(1);
    const expectedFingerprint = computeFingerprint({
      path: "package-lock.json",
      category: Category.DEPENDENCY,
      subcategory: "1093",
      ruleKey: "1093",
      enclosingSymbol: null,
      snippet: "lodash",
    });
    expect(outcome.findings[0]).toMatchObject({
      id: "finding-1",
      fingerprint: expectedFingerprint,
      category: Category.DEPENDENCY,
      subcategory: "1093",
      severity: "high",
      confidence: Confidence.HIGH,
      title: "lodash: Prototype Pollution",
      explanation:
        "npm audit reported Prototype Pollution in this dependency (https://example.com/advisories/1093).",
      impact: "A dependency with a publicly known vulnerability would ship in this change.",
      recommendation: "Upgrade lodash to lodash@4.17.21, which resolves this advisory.",
      path: "package-lock.json",
      startLine: 6,
      endLine: 6,
      diffSide: DiffSide.RIGHT,
      sourceKind: SourceKind.NPM_AUDIT,
      sourceName: "npm-audit",
      headSha: "deadbeef",
      language: "typescript",
      framework: "react",
    });
  });

  it("falls back to the package name and generic wording when the advisory object is empty", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        exitCode: 1,
        stdout: npmAuditStdout({
          lodash: { name: "lodash", severity: "moderate", via: [{}] },
        }),
      }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NESTED]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.findings[0]).toMatchObject({
      subcategory: "lodash",
      severity: "medium",
      title: "lodash: known vulnerability",
      explanation: "npm audit reported a known vulnerability in this dependency.",
      recommendation: "Upgrade lodash to a patched version.",
      startLine: 4,
      endLine: 4,
    });
  });

  it("describes a transitive vulnerability when via contains only strings", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        exitCode: 1,
        stdout: npmAuditStdout({
          "bar-pkg": { name: "bar-pkg", severity: "low", via: ["some-parent-package"] },
        }),
      }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.findings[0]).toMatchObject({
      subcategory: "bar-pkg",
      severity: "low",
      title: "bar-pkg: known vulnerability",
      explanation: "This is a transitive vulnerability, pulled in via some-parent-package.",
      recommendation: "Upgrade bar-pkg to a patched version.",
      startLine: 1,
      endLine: 1,
    });
  });

  it.each([
    ["critical", "critical"],
    ["high", "high"],
    ["moderate", "medium"],
    ["low", "low"],
    ["info", "info"],
    ["something-unrecognized", "medium"],
  ])("maps npm severity %s to %s", async (rawSeverity, expected) => {
    const runner = new FakeSubprocessRunner(
      processResult({
        exitCode: 1,
        stdout: npmAuditStdout({
          "pkg-severity-test": {
            name: "pkg-severity-test",
            severity: rawSeverity,
            via: ["parent"],
          },
        }),
      }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.findings[0]?.severity).toBe(expected);
  });

  it.each([[true], [false]])(
    "recommends a generic upgrade when fixAvailable is the boolean %s",
    async (fixAvailable) => {
      const runner = new FakeSubprocessRunner(
        processResult({
          exitCode: 1,
          stdout: npmAuditStdout({
            "pkg-fix-test": {
              name: "pkg-fix-test",
              severity: "low",
              via: ["parent"],
              fixAvailable,
            },
          }),
        }),
      );
      const scanner = new NpmAuditScanner({
        runner,
        workspace: new TempWorkspaceFactory(),
        ids: new SequentialIdGenerator("finding"),
      });
      const context = makeContext({
        fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
      });

      const outcome = await scanner.analyze(context);

      expect(outcome.findings[0]?.recommendation).toBe(
        "Upgrade pkg-fix-test to a patched version.",
      );
    },
  );

  it("reports a timeout diagnostic naming the manifest", async () => {
    const runner = new FakeSubprocessRunner(processResult({ timedOut: true, exitCode: null }));
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome).toEqual({
      source: "npm-audit",
      status: OutcomeStatus.TIMEOUT,
      findings: [],
      diagnostics: [
        {
          source: "npm-audit",
          status: OutcomeStatus.TIMEOUT,
          message: "npm audit timed out for package-lock.json",
        },
      ],
    });
  });

  it("reports the trimmed stderr on an exit code that is neither 0 nor 1", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({ exitCode: 2, stderr: Buffer.from("  EACCES: permission denied  \n") }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.ERROR);
    expect(outcome.diagnostics).toEqual([
      { source: "npm-audit", status: OutcomeStatus.ERROR, message: "EACCES: permission denied" },
    ]);
  });

  it("falls back to a generic message naming the manifest when stderr is empty", async () => {
    const runner = new FakeSubprocessRunner(processResult({ exitCode: 2 }));
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.diagnostics).toEqual([
      {
        source: "npm-audit",
        status: OutcomeStatus.ERROR,
        message: "npm audit failed for package-lock.json",
      },
    ]);
  });

  it("degrades on syntactically invalid JSON", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({ exitCode: 0, stdout: Buffer.from("{not json") }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.diagnostics).toEqual([
      {
        source: "npm-audit",
        status: OutcomeStatus.ERROR,
        message: "could not parse npm audit output for package-lock.json",
      },
    ]);
  });

  it("degrades on JSON that is syntactically valid but does not match the expected shape", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({ vulnerabilities: "not-an-object" })),
      }),
    );
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.diagnostics).toEqual([
      {
        source: "npm-audit",
        status: OutcomeStatus.ERROR,
        message: "could not parse npm audit output for package-lock.json",
      },
    ]);
  });

  it("audits multiple manifests independently and combines their findings", async () => {
    const runner = new FakeSubprocessRunner([
      processResult({ exitCode: 0, stdout: npmAuditStdout({}) }),
      processResult({
        exitCode: 1,
        stdout: npmAuditStdout({
          "pkg-nested": { name: "pkg-nested", severity: "low", via: ["parent"] },
        }),
      }),
    ]);
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([
        ["package-lock.json", LOCKFILE_NO_MATCH],
        ["packages/api/package-lock.json", LOCKFILE_NO_MATCH],
      ]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.OK);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.diagnostics).toEqual([]);
    expect(runner.commands).toHaveLength(2);
    expect(runner.cwds[0]).not.toBe(runner.cwds[1]);
    expect(runner.cwds[1]).toMatch(/packages[/\\]api$/);
  });

  it("surfaces the first manifest's diagnostic status when no manifest produced findings", async () => {
    const runner = new FakeSubprocessRunner([
      processResult({ timedOut: true, exitCode: null }),
      processResult({ exitCode: 0, stdout: npmAuditStdout({}) }),
    ]);
    const scanner = new NpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([
        ["package-lock.json", LOCKFILE_NO_MATCH],
        ["packages/api/package-lock.json", LOCKFILE_NO_MATCH],
      ]),
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.TIMEOUT);
    expect(outcome.findings).toEqual([]);
    expect(outcome.diagnostics).toEqual([
      {
        source: "npm-audit",
        status: OutcomeStatus.TIMEOUT,
        message: "npm audit timed out for package-lock.json",
      },
    ]);
  });
});

describe("buildNpmAuditScanner", () => {
  it("builds a working scanner", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({ exitCode: 0, stdout: npmAuditStdout({}) }),
    );
    const scanner = buildNpmAuditScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    expect(scanner).toBeInstanceOf(NpmAuditScanner);
    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["package-lock.json", LOCKFILE_NO_MATCH]]) }),
    );
    expect(outcome.status).toBe(OutcomeStatus.ZERO_FINDINGS);
  });
});
