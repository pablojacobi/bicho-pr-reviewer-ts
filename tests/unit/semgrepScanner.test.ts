import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../src/application/analyzers/base.ts";
import { OutcomeStatus } from "../../src/domain/models/analysis.ts";
import { Category, Confidence, DiffSide, SourceKind } from "../../src/domain/models/finding.ts";
import type { TempWorkspace } from "../../src/domain/ports/system.ts";
import { computeFingerprint } from "../../src/domain/services/fingerprint.ts";
import { TempWorkspaceFactory } from "../../src/infrastructure/fs/workspace.ts";
import { SequentialIdGenerator } from "../../src/infrastructure/ids.ts";
import { FakeSubprocessRunner, processResult } from "../../src/infrastructure/process/fake.ts";
import {
  buildSemgrepScanner,
  SemgrepScanner,
} from "../../src/infrastructure/scanners/semgrepRunner.ts";
import { DummyAdapter } from "../helpers/dummyAdapter.ts";

/** A {@link TempWorkspace} that fails the test if it is ever asked to create a directory. */
class PoisonedWorkspace implements TempWorkspace {
  async create(): Promise<never> {
    throw new Error("workspace must not be created when there is nothing to scan");
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

function semgrepStdout(results: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(JSON.stringify({ results }));
}

function semgrepResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    check_id: "typescript.security.eval-with-dynamic-value",
    path: "app/db.ts",
    start: { line: 10 },
    end: { line: 12 },
    extra: { message: "Avoid eval with dynamic input.", severity: "ERROR" },
    ...overrides,
  };
}

describe("SemgrepScanner", () => {
  it("returns zero findings without creating a workspace or running anything when nothing changed", async () => {
    const runner = new FakeSubprocessRunner();
    const scanner = new SemgrepScanner({
      runner,
      workspace: new PoisonedWorkspace(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(makeContext({ fileContents: new Map() }));

    expect(outcome).toEqual({
      source: "semgrep",
      status: OutcomeStatus.ZERO_FINDINGS,
      findings: [],
      diagnostics: [],
    });
    expect(runner.commands).toEqual([]);
  });

  it("runs a clean scan and builds the command with the resolved config and workspace cwd", async () => {
    const runner = new FakeSubprocessRunner(processResult({ stdout: semgrepStdout([]) }));
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({ fileContents: new Map([["app/db.ts", "const x = 1;\n"]]) });

    const outcome = await scanner.analyze(context);

    expect(outcome).toEqual({
      source: "semgrep",
      status: OutcomeStatus.ZERO_FINDINGS,
      findings: [],
      diagnostics: [],
    });
    expect(runner.commands).toEqual([
      [
        "semgrep",
        "scan",
        "--config",
        resolve("resources/semgrep"),
        "--json",
        "--quiet",
        "--disable-version-check",
        "--metrics=off",
        "--no-git-ignore",
        "--timeout",
        "60",
        ".",
      ],
    ]);
    expect(runner.cwds[0]).toContain("bicho-");
  });

  it("honours a custom config path and truncates a fractional timeout for the CLI flag", async () => {
    const runner = new FakeSubprocessRunner(processResult({ stdout: semgrepStdout([]) }));
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
      config: "custom/semgrep-config",
      timeoutSeconds: 5.7,
    });

    await scanner.analyze(makeContext({ fileContents: new Map([["app/db.ts", "x"]]) }));

    const [command] = runner.commands;
    expect(command).toContain(resolve("custom/semgrep-config"));
    expect(command).toContain("5");
    expect(command).not.toContain("5.7");
  });

  it("maps a match into a finding with every field populated correctly", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        stdout: semgrepStdout([
          semgrepResult({
            check_id: "typescript.security.eval-with-dynamic-value",
            path: "./app/db.ts",
            start: { line: 10 },
            end: { line: 12 },
            extra: { message: "Avoid eval with dynamic input.", severity: "ERROR" },
          }),
        ]),
      }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });
    const context = makeContext({
      fileContents: new Map([["app/db.ts", "eval(input);\n"]]),
      headSha: "deadbeef",
      language: "typescript",
      framework: "react",
    });

    const outcome = await scanner.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.OK);
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.findings).toHaveLength(1);
    const expectedFingerprint = computeFingerprint({
      path: "app/db.ts",
      category: Category.SECURITY,
      subcategory: "eval-with-dynamic-value",
      ruleKey: "eval-with-dynamic-value",
      enclosingSymbol: null,
      snippet: "",
    });
    expect(outcome.findings[0]).toMatchObject({
      id: "finding-1",
      fingerprint: expectedFingerprint,
      category: Category.SECURITY,
      subcategory: "eval-with-dynamic-value",
      severity: "high",
      confidence: Confidence.HIGH,
      title: "Semgrep: eval-with-dynamic-value",
      explanation: "Avoid eval with dynamic input.",
      impact: "A static-analysis rule flagged a pattern introduced by this change.",
      recommendation: "Review the flagged pattern and remediate as the rule advises.",
      path: "app/db.ts",
      startLine: 10,
      endLine: 12,
      diffSide: DiffSide.RIGHT,
      sourceKind: SourceKind.SEMGREP,
      sourceName: "semgrep",
      headSha: "deadbeef",
      language: "typescript",
      framework: "react",
    });
  });

  it("leaves a path without a leading ./ untouched", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({ stdout: semgrepStdout([semgrepResult({ path: "app/db.ts" })]) }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.findings[0]?.path).toBe("app/db.ts");
  });

  it("uses the whole check_id as the rule name when it has no dots", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        stdout: semgrepStdout([semgrepResult({ check_id: "no-dots-rule" })]),
      }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.findings[0]?.subcategory).toBe("no-dots-rule");
    expect(outcome.findings[0]?.title).toBe("Semgrep: no-dots-rule");
  });

  it("clamps a range whose reported end precedes its start", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        stdout: semgrepStdout([semgrepResult({ start: { line: 20 }, end: { line: 15 } })]),
      }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.findings[0]?.startLine).toBe(20);
    expect(outcome.findings[0]?.endLine).toBe(20);
  });

  it("falls back to a generic explanation when extra carries no message", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({
        stdout: semgrepStdout([semgrepResult({ extra: {} })]),
      }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.findings[0]?.explanation).toBe("A Semgrep rule matched this code.");
    expect(outcome.findings[0]?.severity).toBe("low");
  });

  it.each([
    ["ERROR", "high"],
    ["WARNING", "medium"],
    ["INFO", "low"],
    ["some-unrecognized-severity", "low"],
  ])("maps semgrep severity %s to %s", async (rawSeverity, expected) => {
    const runner = new FakeSubprocessRunner(
      processResult({
        stdout: semgrepStdout([semgrepResult({ extra: { severity: rawSeverity } })]),
      }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.findings[0]?.severity).toBe(expected);
  });

  it("reports a timeout diagnostic and no findings", async () => {
    const runner = new FakeSubprocessRunner(processResult({ timedOut: true, exitCode: null }));
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome).toEqual({
      source: "semgrep",
      status: OutcomeStatus.TIMEOUT,
      findings: [],
      diagnostics: [
        { source: "semgrep", status: OutcomeStatus.TIMEOUT, message: "semgrep timed out" },
      ],
    });
  });

  it("reports the trimmed stderr on a non-zero exit that produced output", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({ exitCode: 2, stderr: Buffer.from("  boom: bad rule file  \n") }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.status).toBe(OutcomeStatus.ERROR);
    expect(outcome.diagnostics).toEqual([
      { source: "semgrep", status: OutcomeStatus.ERROR, message: "boom: bad rule file" },
    ]);
  });

  it("falls back to a generic message on a non-zero exit with empty stderr", async () => {
    const runner = new FakeSubprocessRunner(processResult({ exitCode: 2 }));
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.diagnostics).toEqual([
      { source: "semgrep", status: OutcomeStatus.ERROR, message: "semgrep exited non-zero" },
    ]);
  });

  it("degrades on syntactically invalid JSON", async () => {
    const runner = new FakeSubprocessRunner(processResult({ stdout: Buffer.from("{not json") }));
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.status).toBe(OutcomeStatus.ERROR);
    expect(outcome.diagnostics).toEqual([
      {
        source: "semgrep",
        status: OutcomeStatus.ERROR,
        message: "could not parse semgrep JSON output",
      },
    ]);
  });

  it("degrades on JSON that is syntactically valid but does not match the expected shape", async () => {
    const runner = new FakeSubprocessRunner(
      processResult({ stdout: Buffer.from(JSON.stringify({ results: "not-an-array" })) }),
    );
    const scanner = new SemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "eval(input);\n"]]) }),
    );

    expect(outcome.status).toBe(OutcomeStatus.ERROR);
    expect(outcome.diagnostics).toEqual([
      {
        source: "semgrep",
        status: OutcomeStatus.ERROR,
        message: "could not parse semgrep JSON output",
      },
    ]);
  });
});

describe("buildSemgrepScanner", () => {
  it("builds a working scanner", async () => {
    const runner = new FakeSubprocessRunner(processResult({ stdout: semgrepStdout([]) }));
    const scanner = buildSemgrepScanner({
      runner,
      workspace: new TempWorkspaceFactory(),
      ids: new SequentialIdGenerator("finding"),
    });

    expect(scanner).toBeInstanceOf(SemgrepScanner);
    const outcome = await scanner.analyze(
      makeContext({ fileContents: new Map([["app/db.ts", "const x = 1;\n"]]) }),
    );
    expect(outcome.status).toBe(OutcomeStatus.ZERO_FINDINGS);
  });
});
