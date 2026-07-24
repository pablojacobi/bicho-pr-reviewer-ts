/**
 * Build the review `StateGraph`.
 *
 * A linear spine (fetch → normalize → detect → gather → select) fans out into a single parallel
 * superstep over the selected analyzers, fans back in at `collect_findings`, then runs a gated
 * publish tail. No checkpointer, no interrupts, no persistence — a review is one bounded run.
 */

import { END, type Runtime, START, StateGraph } from "@langchain/langgraph";
import { type ReviewContext, ReviewContextAnnotation } from "../context.ts";
import {
  collectFindings,
  composeReview,
  detectLanguage,
  fetchChangedFiles,
  fetchPullRequest,
  gatherFileContents,
  idempotencyGuard,
  makeAnalyzerNode,
  type NodeFn,
  normalizeDiff,
  publishGitHubReview,
  routeAfterIdempotency,
  routeAfterStale,
  routeAnalyzers,
  selectAnalyzers,
  staleHeadGuard,
  verifyFindings,
} from "./nodes.ts";
import { type ReviewState, ReviewStateAnnotation } from "./state.ts";

/** A graph compiled by {@link buildGraph}; opaque to callers beyond {@link runGraph}. */
export type ReviewGraph = ReturnType<typeof buildGraph>;

/**
 * Adapt a node to LangGraph's `(state, config)` signature.
 *
 * The per-run context is supplied at invoke time and surfaces on `config.context`. Keeping the
 * unwrapping in one place lets every node keep the far more testable `(state, context)` shape.
 */
function node(fn: NodeFn) {
  return async (state: ReviewState, runtime: Runtime<ReviewContext>) => {
    const context = runtime.context;
    if (context === undefined) {
      throw new Error("the review graph must be invoked with a ReviewContext");
    }
    return fn(state, context);
  };
}

/** Compile the review graph with one fan-out node per analyzer name. */
export function buildGraph(analyzerNames: readonly string[]) {
  const builder = new StateGraph(ReviewStateAnnotation, ReviewContextAnnotation)
    .addNode("fetch_pull_request", node(fetchPullRequest))
    .addNode("fetch_changed_files", node(fetchChangedFiles))
    .addNode("normalize_diff", node(normalizeDiff))
    .addNode("detect_language", node(detectLanguage))
    .addNode("gather_file_contents", node(gatherFileContents))
    .addNode("select_analyzers", node(selectAnalyzers))
    .addNode("collect_findings", node(collectFindings))
    .addNode("verify_findings", node(verifyFindings))
    .addNode("compose_review", node(composeReview))
    .addNode("idempotency_guard", node(idempotencyGuard))
    .addNode("stale_head_guard", node(staleHeadGuard))
    .addNode("publish_github_review", node(publishGitHubReview));

  /**
   * LangGraph tracks node names as literal types so a typo in an edge is a compile error. That is
   * worth keeping for the fixed spine, but it cannot express a set of analyzer names known only at
   * runtime. This is the single place the node-name type is widened; the resulting graph shape is
   * covered by the end-to-end tests, which run the real workflow.
   */
  const dynamic = builder as unknown as {
    addNode(name: string, fn: ReturnType<typeof node>): void;
    addEdge(from: string, to: string): void;
    addConditionalEdges(
      from: string,
      router: (state: ReviewState) => string[],
      paths: string[],
    ): void;
  };

  for (const name of analyzerNames) {
    dynamic.addNode(name, node(makeAnalyzerNode(name)));
  }

  builder.addEdge(START, "fetch_pull_request");
  builder.addEdge("fetch_pull_request", "fetch_changed_files");
  builder.addEdge("fetch_changed_files", "normalize_diff");
  builder.addEdge("normalize_diff", "detect_language");
  builder.addEdge("detect_language", "gather_file_contents");
  builder.addEdge("gather_file_contents", "select_analyzers");
  dynamic.addConditionalEdges("select_analyzers", routeAnalyzers, [
    ...analyzerNames,
    "collect_findings",
  ]);
  for (const name of analyzerNames) {
    dynamic.addEdge(name, "collect_findings");
  }
  builder.addEdge("collect_findings", "verify_findings");
  builder.addEdge("verify_findings", "compose_review");
  builder.addEdge("compose_review", "idempotency_guard");
  builder.addConditionalEdges("idempotency_guard", routeAfterIdempotency, [
    "stale_head_guard",
    END,
  ]);
  builder.addConditionalEdges("stale_head_guard", routeAfterStale, ["publish_github_review", END]);
  builder.addEdge("publish_github_review", END);

  return builder.compile();
}

/** Invoke a compiled review graph and return the final typed state. */
export async function runGraph(
  graph: ReviewGraph,
  initial: { request: ReviewState["request"] },
  context: ReviewContext,
  signal?: AbortSignal,
): Promise<ReviewState> {
  return graph.invoke(initial, { context, ...(signal === undefined ? {} : { signal }) });
}
