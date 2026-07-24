import { describe, expect, it } from "vitest";
import {
  type AnalysisContext,
  LLMAnalyzer,
  renderDiff,
} from "../../src/application/analyzers/base.ts";
import { ANALYZER_CATEGORIES, buildAnalyzers } from "../../src/application/analyzers/registry.ts";
import type { AnalyzerReport, RawFinding } from "../../src/application/analyzers/schemas.ts";
import { getPrompt, PROMPT_VERSION } from "../../src/application/prompts/registry.ts";
import { OutcomeStatus } from "../../src/domain/models/analysis.ts";
import { DiffLineKind, FileChangeKind, type NormalizedDiff } from "../../src/domain/models/diff.ts";
import {
  Category,
  Confidence,
  DiffSide,
  Severity,
  SourceKind,
} from "../../src/domain/models/finding.ts";
import { errorResult, okResult } from "../../src/domain/ports/modelProvider.ts";
import { SequentialIdGenerator } from "../../src/infrastructure/ids.ts";
import { FakeModelProvider } from "../../src/infrastructure/model/fake.ts";
import { DummyAdapter } from "../helpers/dummyAdapter.ts";
import { aDiff } from "../helpers/factories.ts";

function aRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    title: "Title",
    explanation: "Explanation.",
    impact: "Impact.",
    recommendation: "Recommendation.",
    path: "app/db.ts",
    startLine: 11,
    endLine: 11,
    severity: Severity.HIGH,
    confidence: Confidence.MEDIUM,
    subcategory: "sql-injection",
    snippet: "db.query(x)",
    ...overrides,
  };
}

function aContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    diff: aDiff(),
    headSha: "headsha",
    language: "typescript",
    framework: "express",
    correlationId: "corr-1",
    adapter: new DummyAdapter(),
    fileContents: new Map(),
    ...overrides,
  };
}

describe("renderDiff", () => {
  it("renders an empty string for an empty diff", () => {
    expect(renderDiff({ files: [] })).toBe("");
  });

  it("renders a file header with the path and change kind", () => {
    const diff: NormalizedDiff = {
      files: [
        {
          path: "app/db.ts",
          changeKind: FileChangeKind.ADDED,
          previousPath: null,
          isBinary: false,
          hunks: [],
        },
      ],
    };

    expect(renderDiff(diff)).toBe("### app/db.ts (added)");
  });

  it("prefixes lines by kind and numbers them, falling back to oldLine when newLine is absent", () => {
    const diff: NormalizedDiff = {
      files: [
        {
          path: "app/db.ts",
          changeKind: FileChangeKind.MODIFIED,
          previousPath: null,
          isBinary: false,
          hunks: [
            {
              oldStart: 5,
              oldCount: 3,
              newStart: 5,
              newCount: 3,
              sectionHeading: "-5,3 +5,3 @@ function f()",
              lines: [
                { kind: DiffLineKind.CONTEXT, content: "ctx", oldLine: 5, newLine: 5 },
                // A removed line only ever has an oldLine — this exercises the `??` fallback.
                { kind: DiffLineKind.REMOVED, content: "gone", oldLine: 6, newLine: null },
                { kind: DiffLineKind.ADDED, content: "arrived", oldLine: null, newLine: 6 },
              ],
            },
          ],
        },
      ],
    };

    expect(renderDiff(diff)).toBe(
      [
        "### app/db.ts (modified)",
        "@@ -5,3 +5,3 @@ function f()",
        "5\t ctx",
        "6\t-gone",
        "6\t+arrived",
      ].join("\n"),
    );
  });

  it("trims the @@ heading line when the section heading is empty", () => {
    const diff: NormalizedDiff = {
      files: [
        {
          path: "app/db.ts",
          changeKind: FileChangeKind.MODIFIED,
          previousPath: null,
          isBinary: false,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              sectionHeading: "",
              lines: [{ kind: DiffLineKind.CONTEXT, content: "x", oldLine: 1, newLine: 1 }],
            },
          ],
        },
      ],
    };

    expect(renderDiff(diff)).toBe(["### app/db.ts (modified)", "@@", "1\t x"].join("\n"));
  });

  it("renders multiple files separated by a blank line", () => {
    const diff: NormalizedDiff = {
      files: [
        {
          path: "a.ts",
          changeKind: FileChangeKind.MODIFIED,
          previousPath: null,
          isBinary: false,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              sectionHeading: "",
              lines: [{ kind: DiffLineKind.CONTEXT, content: "x", oldLine: 1, newLine: 1 }],
            },
          ],
        },
        {
          path: "b.ts",
          changeKind: FileChangeKind.ADDED,
          previousPath: null,
          isBinary: false,
          hunks: [],
        },
      ],
    };

    expect(renderDiff(diff)).toBe(
      ["### a.ts (modified)", "@@", "1\t x", "", "### b.ts (added)"].join("\n"),
    );
  });
});

describe("LLMAnalyzer.analyze", () => {
  it("maps every RawFinding field onto the domain Finding", async () => {
    const model = new FakeModelProvider([
      okResult<AnalyzerReport>({ findings: [aRawFinding()] }, "gpt-x"),
    ]);
    const analyzer = new LLMAnalyzer({
      role: "security",
      category: Category.SECURITY,
      model,
      ids: new SequentialIdGenerator("f"),
    });
    const context = aContext({ fileContents: new Map([["app/db.ts", "function f() {}"]]) });

    const outcome = await analyzer.analyze(context);

    expect(outcome.status).toBe(OutcomeStatus.OK);
    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding).toMatchObject({
      id: "f-1",
      category: Category.SECURITY,
      subcategory: "sql-injection",
      severity: Severity.HIGH,
      confidence: Confidence.MEDIUM,
      title: "Title",
      explanation: "Explanation.",
      impact: "Impact.",
      recommendation: "Recommendation.",
      path: "app/db.ts",
      startLine: 11,
      endLine: 11,
      diffSide: DiffSide.RIGHT,
      snippet: "db.query(x)",
      sourceKind: SourceKind.LLM_ANALYZER,
      sourceName: "security",
      headSha: "headsha",
      promptVersion: PROMPT_VERSION,
      modelId: "gpt-x",
      language: "typescript",
      framework: "express",
    });
    expect(finding?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports OK with the mapped findings when the model reports issues", async () => {
    const model = new FakeModelProvider([
      okResult<AnalyzerReport>({ findings: [aRawFinding()] }, "gpt-x"),
    ]);
    const analyzer = new LLMAnalyzer({
      role: "security",
      category: Category.SECURITY,
      model,
      ids: new SequentialIdGenerator(),
    });

    const outcome = await analyzer.analyze(aContext());

    expect(outcome.status).toBe(OutcomeStatus.OK);
    expect(outcome.findings).toHaveLength(1);
  });

  it("reports ZERO_FINDINGS with an empty list when the model finds nothing", async () => {
    const model = new FakeModelProvider([okResult<AnalyzerReport>({ findings: [] }, "gpt-x")]);
    const analyzer = new LLMAnalyzer({
      role: "security",
      category: Category.SECURITY,
      model,
      ids: new SequentialIdGenerator(),
    });

    const outcome = await analyzer.analyze(aContext());

    expect(outcome.status).toBe(OutcomeStatus.ZERO_FINDINGS);
    expect(outcome.findings).toEqual([]);
  });

  it("returns an ERROR outcome carrying the error text, and never throws, on a failed model call", async () => {
    const model = new FakeModelProvider([errorResult("upstream 500", "gpt-x")]);
    const analyzer = new LLMAnalyzer({
      role: "security",
      category: Category.SECURITY,
      model,
      ids: new SequentialIdGenerator(),
    });

    const outcome = await analyzer.analyze(aContext());

    expect(outcome.status).toBe(OutcomeStatus.ERROR);
    expect(outcome.findings).toEqual([]);
    expect(outcome.diagnostics).toEqual([
      { source: "security", status: OutcomeStatus.ERROR, message: "upstream 500" },
    ]);
  });

  it("clamps endLine to startLine when the model reports an end before the start", async () => {
    const model = new FakeModelProvider([
      okResult<AnalyzerReport>({ findings: [aRawFinding({ startLine: 20, endLine: 5 })] }, "gpt-x"),
    ]);
    const analyzer = new LLMAnalyzer({
      role: "security",
      category: Category.SECURITY,
      model,
      ids: new SequentialIdGenerator(),
    });

    const outcome = await analyzer.analyze(aContext());

    expect(outcome.findings[0]?.startLine).toBe(20);
    expect(outcome.findings[0]?.endLine).toBe(20);
  });

  describe("enclosingSymbol lookups", () => {
    async function analyzeWithSymbol(symbol: string | null, contentPresent: boolean) {
      const raw = aRawFinding();
      const model = new FakeModelProvider([okResult<AnalyzerReport>({ findings: [raw] }, "m")]);
      const analyzer = new LLMAnalyzer({
        role: "security",
        category: Category.SECURITY,
        model,
        ids: new SequentialIdGenerator(),
      });
      const context = aContext({
        adapter: new DummyAdapter({ symbol }),
        fileContents: contentPresent ? new Map([[raw.path, "function f() {}"]]) : new Map(),
      });
      return analyzer.analyze(context);
    }

    it("feeds the adapter's symbol into the fingerprint when the file's content is present", async () => {
      const withA = await analyzeWithSymbol("funcA", true);
      const withB = await analyzeWithSymbol("funcB", true);

      expect(withA.findings[0]?.fingerprint).not.toBe(withB.findings[0]?.fingerprint);
    });

    it("never consults the adapter (fingerprint unaffected by its symbol) when content is absent", async () => {
      const withA = await analyzeWithSymbol("funcA", false);
      const withB = await analyzeWithSymbol("funcB", false);

      expect(withA.findings[0]?.fingerprint).toBe(withB.findings[0]?.fingerprint);
    });
  });

  it("sends a prompt containing the role's template and the diff section", async () => {
    const model = new FakeModelProvider([okResult<AnalyzerReport>({ findings: [] }, "m")]);
    const analyzer = new LLMAnalyzer({
      role: "security",
      category: Category.SECURITY,
      model,
      ids: new SequentialIdGenerator(),
    });

    await analyzer.analyze(aContext());

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.prompt).toContain(getPrompt("security"));
    expect(model.calls[0]?.prompt).toContain("## Diff");
  });

  it("tags the model call's RunMeta with the role, prompt version, and correlation id", async () => {
    const model = new FakeModelProvider([okResult<AnalyzerReport>({ findings: [] }, "m")]);
    const analyzer = new LLMAnalyzer({
      role: "performance",
      category: Category.PERFORMANCE,
      model,
      ids: new SequentialIdGenerator(),
    });

    await analyzer.analyze(aContext({ correlationId: "corr-42" }));

    expect(model.calls[0]?.meta).toEqual({
      role: "performance",
      promptVersion: PROMPT_VERSION,
      correlationId: "corr-42",
      tags: [],
    });
  });
});

describe("buildAnalyzers", () => {
  it("returns exactly the six analyzer roles", () => {
    const analyzers = buildAnalyzers({
      model: new FakeModelProvider([]),
      ids: new SequentialIdGenerator(),
    });

    expect([...analyzers.keys()].sort()).toEqual(
      ["contracts", "correctness", "maintainability", "performance", "security", "tests"].sort(),
    );
  });

  it.each(Object.entries(ANALYZER_CATEGORIES))(
    "wires role %s to category %s, as an LLMAnalyzer",
    async (role, category) => {
      const model = new FakeModelProvider([
        okResult<AnalyzerReport>({ findings: [aRawFinding()] }, "m"),
      ]);
      const analyzers = buildAnalyzers({ model, ids: new SequentialIdGenerator() });
      const analyzer = analyzers.get(role);

      expect(analyzer).toBeInstanceOf(LLMAnalyzer);

      const outcome = await analyzer?.analyze(aContext());

      expect(outcome?.findings[0]?.category).toBe(category);
    },
  );
});
