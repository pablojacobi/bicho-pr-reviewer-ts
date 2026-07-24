/**
 * The graph's structural edge cases.
 *
 * The end-to-end tests cover the happy paths through the real workflow; these cover the guards that
 * only fire when the graph is wired or invoked incorrectly, plus the small mapping branches on the
 * spine that a full run does not naturally reach.
 */

import { describe, expect, it } from "vitest";
import type { Analyzer } from "../../src/application/analyzers/base.ts";
import type { ReviewContext } from "../../src/application/context.ts";
import { buildGraph, runGraph } from "../../src/application/graph/builder.ts";
import {
  gatherFileContents,
  makeAnalyzerNode,
  normalizeDiff,
  routeAfterIdempotency,
  routeAfterStale,
  routeAnalyzers,
} from "../../src/application/graph/nodes.ts";
import type { ReviewStateUpdate } from "../../src/application/graph/state.ts";
import { type ReviewState, required } from "../../src/application/graph/state.ts";
import { ReviewService } from "../../src/application/reviewService.ts";
import { PullRequestNotFoundError } from "../../src/domain/errors.ts";
import { FileChangeKind } from "../../src/domain/models/diff.ts";
import {
  makeReviewOptions,
  type ReviewRequest,
  ReviewStatus,
  ReviewTrigger,
} from "../../src/domain/models/review.ts";
import { DiffParser } from "../../src/infrastructure/diff/hunkParser.ts";
import { FakeGitHub } from "../../src/infrastructure/github/fake.ts";
import { SequentialIdGenerator } from "../../src/infrastructure/ids.ts";
import { DummyAdapter, FixedAdapterRegistry } from "../helpers/dummyAdapter.ts";
import { aChangedFile, aPullRequest } from "../helpers/factories.ts";

const request = {
  repository: "octo/hello-world",
  prNumber: 42,
  installationId: null,
  headShaHint: null,
  trigger: ReviewTrigger.MANUAL,
};

/** A state populated far enough for the node under test. */
function aState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    request,
    outcomes: [],
    pullRequest: aPullRequest(),
    changedFiles: [],
    diff: { files: [] },
    language: "dummy",
    adapter: new DummyAdapter(),
    fileContents: new Map(),
    selected: [],
    findings: [],
    reviewDraft: null,
    decision: null,
    publishedReviewId: null,
    ...overrides,
  };
}

const context = { diffParser: new DiffParser() } as unknown as ReviewContext;

/**
 * Read a node's update as plain state.
 *
 * LangGraph's update type also admits reducer-control wrappers, which nodes here never return; this
 * narrows to the shape the nodes actually produce so assertions can reach into it.
 */
function asState(update: ReviewStateUpdate): Partial<ReviewState> {
  return update as Partial<ReviewState>;
}

describe("normalizeDiff", () => {
  it.each([
    ["added", FileChangeKind.ADDED],
    ["removed", FileChangeKind.REMOVED],
    ["renamed", FileChangeKind.RENAMED],
    ["modified", FileChangeKind.MODIFIED],
  ])("maps the %s status", async (status, expected) => {
    const state = aState({ changedFiles: [aChangedFile({ status })] });

    const update = asState(await normalizeDiff(state, context));

    expect(update.diff?.files[0]?.changeKind).toBe(expected);
  });

  it("falls back to modified for a status GitHub has not documented", async () => {
    const state = aState({ changedFiles: [aChangedFile({ status: "copied" })] });

    const update = asState(await normalizeDiff(state, context));

    expect(update.diff?.files[0]?.changeKind).toBe(FileChangeKind.MODIFIED);
  });

  it("marks a file with no patch as binary and gives it no hunks", async () => {
    const state = aState({ changedFiles: [aChangedFile({ patch: null })] });

    const file = asState(await normalizeDiff(state, context)).diff?.files[0];

    expect(file?.isBinary).toBe(true);
    expect(file?.hunks).toEqual([]);
  });

  it("carries a rename's previous path through", async () => {
    const state = aState({
      changedFiles: [aChangedFile({ status: "renamed", previousFilename: "app/old.ts" })],
    });

    expect(asState(await normalizeDiff(state, context)).diff?.files[0]?.previousPath).toBe(
      "app/old.ts",
    );
  });
});

describe("routers", () => {
  it("fans out to the selected analyzers", () => {
    expect(routeAnalyzers(aState({ selected: ["security", "semgrep"] }))).toEqual([
      "security",
      "semgrep",
    ]);
  });

  it("goes straight to collection when nothing was selected", () => {
    expect(routeAnalyzers(aState({ selected: [] }))).toEqual(["collect_findings"]);
  });

  it("continues to the stale-head guard when no decision was made", () => {
    expect(routeAfterIdempotency(aState({ decision: null }))).toBe("stale_head_guard");
  });

  it.each([ReviewStatus.DRY_RUN, ReviewStatus.SKIPPED])(
    "ends the run on a %s decision",
    (decision) => {
      expect(routeAfterIdempotency(aState({ decision }))).toBe("__end__");
    },
  );

  it("publishes when the head has not moved", () => {
    expect(routeAfterStale(aState({ decision: null }))).toBe("publish_github_review");
  });

  it("ends the run when the head went stale", () => {
    expect(routeAfterStale(aState({ decision: ReviewStatus.STALE }))).toBe("__end__");
  });
});

describe("required", () => {
  it("returns a populated value unchanged", () => {
    expect(required("value", "field")).toBe("value");
  });

  it.each([0, "", false])("returns the falsy-but-present value %s", (value) => {
    expect(required(value, "field")).toBe(value);
  });

  it("names the field when the graph ordering left it unpopulated", () => {
    expect(() => required(null, "pullRequest")).toThrow(/pullRequest/);
  });
});

describe("makeAnalyzerNode", () => {
  it("degrades to a diagnostic when no analyzer is registered under the name", async () => {
    const node = makeAnalyzerNode("ghost");

    const update = asState(
      await node(aState(), { analyzers: new Map() } as unknown as ReviewContext),
    );

    expect(update.outcomes?.[0]?.status).toBe("error");
    expect(update.outcomes?.[0]?.diagnostics[0]?.message).toContain("ghost");
  });
});

describe("buildGraph", () => {
  it("refuses to run without a review context", async () => {
    const graph = buildGraph([]);

    await expect(
      runGraph(graph, { request }, undefined as unknown as ReviewContext),
    ).rejects.toThrow(/must be invoked with a ReviewContext/);
  });
});

describe("gatherFileContents", () => {
  it("skips a changed file the adapter considers out of scope", async () => {
    const github = new FakeGitHub({
      pullRequest: aPullRequest(),
      fileContents: { "app/db.ts": "const a = 1;", "docs/readme.md": "# docs" },
    });
    const state = {
      pullRequest: aPullRequest(),
      adapter: new DummyAdapter(),
      // The dummy adapter scopes to files that carry a patch; the second has none.
      changedFiles: [aChangedFile(), aChangedFile({ filename: "docs/readme.md", patch: null })],
    } as unknown as ReviewState;

    const update = await gatherFileContents(state, { github } as unknown as ReviewContext);

    expect([...(update.fileContents as Map<string, string>).keys()]).toEqual(["app/db.ts"]);
  });

  it("skips an in-scope file whose content could not be read", async () => {
    const github = new FakeGitHub({ pullRequest: aPullRequest(), fileContents: {} });
    const state = {
      pullRequest: aPullRequest(),
      adapter: new DummyAdapter(),
      changedFiles: [aChangedFile()],
    } as unknown as ReviewState;

    const update = await gatherFileContents(state, { github } as unknown as ReviewContext);

    expect((update.fileContents as Map<string, string>).size).toBe(0);
  });
});

describe("ReviewService", () => {
  const request: ReviewRequest = {
    repository: "octo/hello-world",
    prNumber: 42,
    installationId: null,
    headShaHint: null,
    trigger: ReviewTrigger.MANUAL,
  };

  it("propagates a genuine failure rather than reporting it as a timeout", async () => {
    // The timeout backstop must not swallow real bugs: only an aborted run becomes FAILED.
    const service = new ReviewService({
      graph: buildGraph([]),
      github: new FakeGitHub(),
      diffParser: new DiffParser(),
      adapters: new FixedAdapterRegistry(new DummyAdapter({ analyzers: [] })),
      analyzers: new Map<string, Analyzer>(),
      ids: new SequentialIdGenerator("run"),
    });

    await expect(service.run(request, makeReviewOptions({ dryRun: true }))).rejects.toThrow(
      PullRequestNotFoundError,
    );
  });
});
