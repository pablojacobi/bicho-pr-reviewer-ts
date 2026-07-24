/**
 * End-to-end runs of the whole review pipeline, entirely offline.
 *
 * No network, no credentials, no real model or scanner binary: GitHub and the model provider are
 * fakes, so these exercise the real LangGraph workflow, the real composition, and the real publish
 * guards. This is the test that would catch a graph rewiring mistake that types alone cannot.
 */

import { describe, expect, it } from "vitest";
import type { Analyzer } from "../../src/application/analyzers/base.ts";
import { buildAnalyzers } from "../../src/application/analyzers/registry.ts";
import type {
  AnalyzerReport,
  VerificationReport,
} from "../../src/application/analyzers/schemas.ts";
import { buildGraph } from "../../src/application/graph/builder.ts";
import { WORKFLOW_VERSION } from "../../src/application/graph/compose.ts";
import { ReviewService } from "../../src/application/reviewService.ts";
import { LLMFindingVerifier, PolicyVerifier } from "../../src/application/verifier.ts";
import {
  type AnalyzerOutcome,
  makeOutcome,
  OutcomeStatus,
} from "../../src/domain/models/analysis.ts";
import {
  Category,
  Confidence,
  makeFinding,
  Severity,
  SourceKind,
} from "../../src/domain/models/finding.ts";
import { renderMarker } from "../../src/domain/models/marker.ts";
import {
  makeReviewOptions,
  type ReviewRequest,
  ReviewStatus,
  ReviewTrigger,
} from "../../src/domain/models/review.ts";
import type { ModelResult } from "../../src/domain/ports/modelProvider.ts";
import { errorResult, okResult } from "../../src/domain/ports/modelProvider.ts";
import { computeFingerprint } from "../../src/domain/services/fingerprint.ts";
import { DiffParser } from "../../src/infrastructure/diff/hunkParser.ts";
import { FakeGitHub } from "../../src/infrastructure/github/fake.ts";
import { SequentialIdGenerator } from "../../src/infrastructure/ids.ts";
import { FakeModelProvider } from "../../src/infrastructure/model/fake.ts";
import { DummyAdapter, FixedAdapterRegistry } from "../helpers/dummyAdapter.ts";
import { aChangedFile, aPullRequest } from "../helpers/factories.ts";

const request: ReviewRequest = {
  repository: "octo/hello-world",
  prNumber: 42,
  installationId: 7,
  headShaHint: null,
  trigger: ReviewTrigger.MANUAL,
};

/** One finding anchored to line 11, which is an added line in the sample patch. */
function aReport(overrides: Partial<AnalyzerReport["findings"][number]> = {}): AnalyzerReport {
  return {
    findings: [
      {
        title: "Unvalidated input reaches the query",
        explanation: "The value is interpolated straight into SQL.",
        impact: "An attacker can read arbitrary rows.",
        recommendation: "Use a parameterized query.",
        path: "app/db.ts",
        startLine: 11,
        endLine: 11,
        severity: Severity.HIGH,
        confidence: Confidence.HIGH,
        subcategory: "sql-injection",
        snippet: "db.query(`SELECT ${id}`)",
        ...overrides,
      },
    ],
  };
}

function buildService(options: {
  results?: readonly ModelResult<unknown>[];
  github?: FakeGitHub;
  analyzerNames?: readonly string[];
  verifierModel?: FakeModelProvider | null;
  timeoutSeconds?: number | null;
  extraAnalyzers?: ReadonlyMap<string, Analyzer>;
}) {
  const github =
    options.github ??
    new FakeGitHub({
      pullRequest: aPullRequest(),
      changedFiles: [aChangedFile()],
      fileContents: { "app/db.ts": "const a = 1;\n" },
    });
  const model = new FakeModelProvider(options.results ?? []);
  const analyzerNames = options.analyzerNames ?? ["correctness", "security"];
  const analyzers = new Map<string, Analyzer>(
    [...buildAnalyzers({ model, ids: new SequentialIdGenerator("f") })].filter(([name]) =>
      analyzerNames.includes(name),
    ),
  );
  for (const [name, analyzer] of options.extraAnalyzers ?? new Map()) {
    analyzers.set(name, analyzer);
  }
  const service = new ReviewService({
    graph: buildGraph([...analyzers.keys()]),
    github,
    diffParser: new DiffParser(),
    adapters: new FixedAdapterRegistry(new DummyAdapter({ analyzers: [...analyzers.keys()] })),
    analyzers,
    ids: new SequentialIdGenerator("run"),
    verifier:
      options.verifierModel == null
        ? new PolicyVerifier()
        : new LLMFindingVerifier({ model: options.verifierModel }),
    timeoutSeconds: options.timeoutSeconds ?? null,
  });
  return { service, github, model };
}

describe("review pipeline (dry run)", () => {
  it("composes a draft with an inline comment and publishes nothing", async () => {
    const { service, github } = buildService({
      results: [okResult(aReport(), "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe(ReviewStatus.DRY_RUN);
    expect(result.confirmedCount).toBe(1);
    expect(result.draft?.inlineComments).toHaveLength(1);
    expect(result.draft?.inlineComments[0]).toMatchObject({ path: "app/db.ts", line: 11 });
    expect(result.draft?.event).toBe("REQUEST_CHANGES");
    expect(github.published).toHaveLength(0);
  });

  it("reports no confirmed issues when every analyzer finds nothing", async () => {
    const { service } = buildService({
      results: [okResult({ findings: [] }, "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.confirmedCount).toBe(0);
    expect(result.draft?.summary).toContain("No confirmed issues found.");
    expect(result.draft?.event).toBe("COMMENT");
  });

  it("routes a finding that cannot be anchored to the diff into the summary", async () => {
    const { service } = buildService({
      results: [
        okResult(aReport({ startLine: 900, endLine: 900 }), "fake-model"),
        okResult({ findings: [] }, "fake-model"),
      ],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.draft?.inlineComments).toHaveLength(0);
    expect(result.draft?.summary).toContain("Findings not anchorable to the diff");
    expect(result.draft?.summary).toContain("app/db.ts:900");
  });

  it("embeds a marker carrying the analyzed head SHA and workflow version", async () => {
    const { service } = buildService({
      results: [okResult({ findings: [] }, "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.draft?.summary).toContain(`head_sha=headsha`);
    expect(result.draft?.summary).toContain(`workflow_version=${WORKFLOW_VERSION}`);
  });

  it("emits one multi-line comment for a multi-line finding", async () => {
    const { service } = buildService({
      results: [
        okResult(aReport({ startLine: 10, endLine: 12 }), "fake-model"),
        okResult({ findings: [] }, "fake-model"),
      ],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.draft?.inlineComments[0]).toMatchObject({
      line: 12,
      startLine: 10,
      startSide: "RIGHT",
    });
  });
});

describe("degradation", () => {
  it("surfaces a failed analyzer as an analysis note instead of aborting the run", async () => {
    const { service } = buildService({
      results: [errorResult("upstream 503", "fake-model"), okResult(aReport(), "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe(ReviewStatus.DRY_RUN);
    expect(result.draft?.summary).toContain("### Analysis notes");
    expect(result.draft?.summary).toContain("upstream 503");
    // The other analyzer's finding still made it through.
    expect(result.confirmedCount).toBe(1);
  });

  it("does not roll back the superstep when an analyzer throws outright", async () => {
    const exploding: Analyzer = {
      analyze: () => Promise.reject(new Error("analyzer exploded")),
    };
    const { service } = buildService({
      results: [okResult(aReport(), "fake-model")],
      analyzerNames: ["correctness"],
      extraAnalyzers: new Map([["exploding", exploding]]),
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe(ReviewStatus.DRY_RUN);
    expect(result.draft?.summary).toContain("analyzer exploded");
    expect(result.confirmedCount).toBe(1);
  });

  it("runs to completion when no analyzer is selected at all", async () => {
    const analyzers = new Map<string, Analyzer>();
    const github = new FakeGitHub({
      pullRequest: aPullRequest(),
      changedFiles: [aChangedFile()],
    });
    const service = new ReviewService({
      graph: buildGraph([]),
      github,
      diffParser: new DiffParser(),
      adapters: new FixedAdapterRegistry(new DummyAdapter({ analyzers: [] })),
      analyzers,
      ids: new SequentialIdGenerator("run"),
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe(ReviewStatus.DRY_RUN);
    expect(result.totalCount).toBe(0);
  });
});

describe("publishing and its guards", () => {
  it("publishes exactly one review when not a dry run", async () => {
    const { service, github } = buildService({
      results: [okResult(aReport(), "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: false }));

    expect(result.status).toBe(ReviewStatus.COMPLETED);
    expect(result.reviewId).toBe(1000);
    expect(github.published).toHaveLength(1);
    expect(github.published[0]?.commitId).toBe("headsha");
  });

  it("skips a head that a prior Bicho review already covered", async () => {
    const github = new FakeGitHub({
      pullRequest: aPullRequest(),
      changedFiles: [aChangedFile()],
      reviews: [
        {
          id: 1,
          author: "bicho[bot]",
          body: renderMarker({
            headSha: "headsha",
            workflowVersion: WORKFLOW_VERSION,
            runFingerprint: "x",
            modelId: "m",
            promptVersion: "v1",
          }),
        },
      ],
    });
    const { service } = buildService({
      github,
      results: [okResult({ findings: [] }, "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: false }));

    expect(result.status).toBe(ReviewStatus.SKIPPED);
    expect(github.published).toHaveLength(0);
  });

  it("re-reviews an already-reviewed head when forced", async () => {
    const github = new FakeGitHub({
      pullRequest: aPullRequest(),
      changedFiles: [aChangedFile()],
      reviews: [
        {
          id: 1,
          author: "bicho[bot]",
          body: renderMarker({
            headSha: "headsha",
            workflowVersion: WORKFLOW_VERSION,
            runFingerprint: "x",
            modelId: "m",
            promptVersion: "v1",
          }),
        },
      ],
    });
    const { service } = buildService({
      github,
      results: [okResult({ findings: [] }, "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: false, force: true }));

    expect(result.status).toBe(ReviewStatus.COMPLETED);
    expect(github.published).toHaveLength(1);
  });

  it("ignores an unrelated review that carries no marker", async () => {
    const github = new FakeGitHub({
      pullRequest: aPullRequest(),
      changedFiles: [aChangedFile()],
      reviews: [{ id: 1, author: "human", body: "Looks good to me!" }],
    });
    const { service } = buildService({
      github,
      results: [okResult({ findings: [] }, "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: false }));

    expect(result.status).toBe(ReviewStatus.COMPLETED);
  });

  it("aborts without publishing when the head moves during analysis", async () => {
    const github = new FakeGitHub({
      pullRequest: aPullRequest(),
      changedFiles: [aChangedFile()],
      movedHeadSha: "newsha",
    });
    const { service } = buildService({
      github,
      results: [okResult(aReport(), "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: false }));

    expect(result.status).toBe(ReviewStatus.STALE);
    expect(github.published).toHaveLength(0);
  });
});

describe("verification", () => {
  it("drops a finding the LLM verifier rejects", async () => {
    const verifierModel = new FakeModelProvider([
      okResult<VerificationReport>(
        { verdicts: [{ index: 0, keep: false, reason: "not introduced by this diff" }] },
        "fake-model",
      ),
    ]);
    const { service } = buildService({
      results: [okResult(aReport(), "fake-model"), okResult({ findings: [] }, "fake-model")],
      verifierModel,
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.confirmedCount).toBe(0);
    expect(result.totalCount).toBe(1);
    expect(result.draft?.inlineComments).toHaveLength(0);
  });

  it("keeps a finding the LLM verifier confirms", async () => {
    const verifierModel = new FakeModelProvider([
      okResult<VerificationReport>({ verdicts: [{ index: 0, keep: true, reason: "" }] }, "fake"),
    ]);
    const { service } = buildService({
      results: [okResult(aReport(), "fake-model"), okResult({ findings: [] }, "fake-model")],
      verifierModel,
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.confirmedCount).toBe(1);
  });

  it("falls back to the deterministic policy when the verifier call fails", async () => {
    const verifierModel = new FakeModelProvider([errorResult("verifier timeout", "fake-model")]);
    const { service } = buildService({
      results: [okResult(aReport(), "fake-model"), okResult({ findings: [] }, "fake-model")],
      verifierModel,
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    // The policy confirms a high-confidence finding, so the review is no worse than without the LLM.
    expect(result.confirmedCount).toBe(1);
  });

  it("rejects a low-confidence finding under the deterministic policy", async () => {
    const { service } = buildService({
      results: [
        okResult(aReport({ confidence: Confidence.LOW }), "fake-model"),
        okResult({ findings: [] }, "fake-model"),
      ],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.confirmedCount).toBe(0);
    expect(result.totalCount).toBe(1);
  });
});

describe("deduplication across sources", () => {
  /**
   * A stand-in for the Semgrep scanner: it reports the *same* issue as the security analyzer, with
   * the same fingerprint, from an independent source. This is the real deduplication case — two
   * analyzers of different categories are legitimately two findings, because the category is part
   * of a finding's identity.
   */
  const corroborating: Analyzer = {
    analyze: async (context) =>
      makeOutcome({
        source: "semgrep",
        status: OutcomeStatus.OK,
        findings: [
          makeFinding({
            id: "semgrep-1",
            fingerprint: computeFingerprint({
              path: "app/db.ts",
              category: Category.SECURITY,
              subcategory: "sql-injection",
              ruleKey: "sql-injection",
              enclosingSymbol: null,
              snippet: "db.query(`SELECT ${id}`)",
            }),
            category: Category.SECURITY,
            subcategory: "sql-injection",
            severity: Severity.HIGH,
            confidence: Confidence.MEDIUM,
            title: "Semgrep: sql-injection",
            explanation: "A rule matched this code.",
            impact: "Impact.",
            recommendation: "Remediate as the rule advises.",
            path: "app/db.ts",
            startLine: 11,
            endLine: 11,
            snippet: "db.query(`SELECT ${id}`)",
            sourceKind: SourceKind.SEMGREP,
            sourceName: "semgrep",
            headSha: context.headSha,
            language: context.language,
          }),
        ],
      }),
  };

  it("merges the same issue found by two independent sources into one comment", async () => {
    const { service } = buildService({
      results: [okResult(aReport(), "fake-model")],
      analyzerNames: ["security"],
      extraAnalyzers: new Map([["semgrep", corroborating]]),
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.totalCount).toBe(2);
    expect(result.confirmedCount).toBe(1);
    expect(result.draft?.inlineComments).toHaveLength(1);
  });

  it("keeps findings of different categories apart, even for the same line", async () => {
    const { service } = buildService({
      results: [okResult(aReport(), "fake-model"), okResult(aReport(), "fake-model")],
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.totalCount).toBe(2);
    expect(result.confirmedCount).toBe(2);
  });
});

describe("analyzer prompts", () => {
  it("sends the diff to each analyzer and tags the call with its role", async () => {
    const { service, model } = buildService({
      results: [okResult({ findings: [] }, "fake-model"), okResult({ findings: [] }, "fake-model")],
    });

    await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(model.calls).toHaveLength(2);
    expect(model.calls.map((call) => call.meta.role).sort()).toEqual(["correctness", "security"]);
    for (const call of model.calls) {
      expect(call.prompt).toContain("## Diff");
      expect(call.prompt).toContain("app/db.ts");
      expect(call.prompt).toContain("untrusted data");
      expect(call.meta.correlationId).toBe("run-1");
    }
  });
});

describe("the total-run timeout backstop", () => {
  it("ends cleanly as FAILED rather than hanging", async () => {
    const slow: Analyzer = {
      analyze: () =>
        new Promise<AnalyzerOutcome>((_resolve, reject) => {
          setTimeout(() => reject(new Error("never")), 5_000).unref?.();
        }),
    };
    const { service } = buildService({
      analyzerNames: [],
      extraAnalyzers: new Map([["slow", slow]]),
      timeoutSeconds: 0.1,
    });

    const result = await service.run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe(ReviewStatus.FAILED);
    expect(result.draft).toBeNull();
  });
});
