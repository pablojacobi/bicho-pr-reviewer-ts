/** LangGraph node functions for the review workflow. */

import { END } from "@langchain/langgraph";
import { FileChangeKind, type FileDiff } from "../../domain/models/diff.ts";
import { parseMarker } from "../../domain/models/marker.ts";
import type { ChangedFile, PullRequest } from "../../domain/models/pullRequest.ts";
import { ReviewStatus } from "../../domain/models/review.ts";
import type { DiffParserPort } from "../../domain/ports/diffParser.ts";
import type { GitHubPort } from "../../domain/ports/github.ts";
import type { LanguageAdapter } from "../../domain/ports/languageAdapter.ts";
import { deduplicate } from "../../domain/services/dedup.ts";
import type { AnalysisContext } from "../analyzers/base.ts";
import type { ReviewContext } from "../context.ts";
import { composeReviewDraft, WORKFLOW_VERSION } from "./compose.ts";
import { resilientOutcome } from "./resilience.ts";
import { type ReviewState, type ReviewStateUpdate, required } from "./state.ts";

/** A node reads state plus the per-run context and returns a partial state update. */
export type NodeFn = (state: ReviewState, context: ReviewContext) => Promise<ReviewStateUpdate>;

const CHANGE_KIND: Readonly<Record<string, FileChangeKind>> = {
  added: FileChangeKind.ADDED,
  removed: FileChangeKind.REMOVED,
  renamed: FileChangeKind.RENAMED,
};

export const fetchPullRequest: NodeFn = async (state, context) => ({
  pullRequest: await context.github.fetchPullRequest(
    state.request.repository,
    state.request.prNumber,
  ),
});

export const fetchChangedFiles: NodeFn = async (state, context) => ({
  changedFiles: await context.github.fetchChangedFiles(
    state.request.repository,
    state.request.prNumber,
  ),
});

export const normalizeDiff: NodeFn = async (state, context) => ({
  diff: {
    files: state.changedFiles.map((changed) => toFileDiff(changed, context.diffParser)),
  },
});

export const detectLanguage: NodeFn = async (state, context) => {
  const adapter = context.adapters.select(state.changedFiles);
  return { adapter, language: adapter.language };
};

/** Fetch the head content of in-scope changed files, for symbol resolution and scanners. */
export const gatherFileContents: NodeFn = async (state, context) => ({
  fileContents: await collectContents(
    context.github,
    required(state.pullRequest, "pullRequest"),
    required(state.adapter, "adapter"),
    state.changedFiles,
  ),
});

async function collectContents(
  github: GitHubPort,
  pullRequest: PullRequest,
  adapter: LanguageAdapter,
  changedFiles: readonly ChangedFile[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const changed of changedFiles) {
    if (!adapter.inScope(changed)) {
      continue;
    }
    const content = await github.fetchFileContent(
      pullRequest.repository,
      changed.filename,
      pullRequest.headSha,
    );
    if (content !== null) {
      contents.set(changed.filename, content);
    }
  }
  return contents;
}

export const selectAnalyzers: NodeFn = async (state, context) => ({
  selected: required(state.adapter, "adapter")
    .defaultAnalyzers()
    .filter((name) => context.analyzers.has(name)),
});

export const collectFindings: NodeFn = async (state) => ({
  findings: deduplicate(state.outcomes.flatMap((outcome) => outcome.findings)),
});

export const verifyFindings: NodeFn = async (state, context) => ({
  findings: await context.verifier.verify(state.findings, {
    diff: state.diff,
    correlationId: context.correlationId,
  }),
});

export const composeReview: NodeFn = async (state) => ({
  reviewDraft: composeReviewDraft({
    findings: state.findings,
    diff: state.diff,
    pullRequest: required(state.pullRequest, "pullRequest"),
    outcomes: state.outcomes,
  }),
});

/**
 * Decide whether to publish. Short-circuits a dry run, and skips an already-reviewed head.
 *
 * A decision is set only for the terminal outcomes (dry run, already reviewed); leaving it unset
 * means "proceed to the stale-head guard, then publish".
 */
export const idempotencyGuard: NodeFn = async (state, context) => {
  if (context.options.dryRun) {
    return { decision: ReviewStatus.DRY_RUN };
  }
  if (context.options.force) {
    return {};
  }
  const pullRequest = required(state.pullRequest, "pullRequest");
  const reviews = await context.github.listReviews(pullRequest.repository, pullRequest.number);
  for (const review of reviews) {
    const marker = parseMarker(review.body);
    if (
      marker !== null &&
      marker.headSha === pullRequest.headSha &&
      marker.workflowVersion === WORKFLOW_VERSION
    ) {
      return { decision: ReviewStatus.SKIPPED };
    }
  }
  return {};
};

/** Re-fetch the head SHA just before publishing and abort if the PR moved under us. */
export const staleHeadGuard: NodeFn = async (state, context) => {
  const analyzed = required(state.pullRequest, "pullRequest");
  const current = await context.github.fetchPullRequest(analyzed.repository, analyzed.number);
  return current.headSha === analyzed.headSha ? {} : { decision: ReviewStatus.STALE };
};

/** Publish the composed review as one GitHub review and record its id. */
export const publishGitHubReview: NodeFn = async (state, context) => {
  const pullRequest = required(state.pullRequest, "pullRequest");
  const reviewId = await context.github.publishReview(
    pullRequest.repository,
    pullRequest.number,
    required(state.reviewDraft, "reviewDraft"),
  );
  return { decision: ReviewStatus.COMPLETED, publishedReviewId: reviewId };
};

/** Fan out to the selected analyzers, or straight to collection when none apply. */
export function routeAnalyzers(state: ReviewState): string[] {
  return state.selected.length > 0 ? state.selected : ["collect_findings"];
}

/** Proceed to the stale-head guard unless a terminal decision was already made. */
export function routeAfterIdempotency(state: ReviewState): string {
  return state.decision !== null ? END : "stale_head_guard";
}

/** Publish unless the head went stale. */
export function routeAfterStale(state: ReviewState): string {
  return state.decision === ReviewStatus.STALE ? END : "publish_github_review";
}

/** Build the resilient fan-out node for one analyzer name. */
export function makeAnalyzerNode(name: string): NodeFn {
  return async (state, context) =>
    resilientOutcome(name, async () => {
      const analyzer = context.analyzers.get(name);
      if (analyzer === undefined) {
        throw new Error(`no analyzer registered under ${JSON.stringify(name)}`);
      }
      const analysis: AnalysisContext = {
        diff: state.diff,
        headSha: required(state.pullRequest, "pullRequest").headSha,
        language: state.language,
        framework: null,
        correlationId: context.correlationId,
        adapter: required(state.adapter, "adapter"),
        fileContents: state.fileContents,
      };
      return analyzer.analyze(analysis);
    });
}

function toFileDiff(changed: ChangedFile, parser: DiffParserPort): FileDiff {
  return {
    path: changed.filename,
    changeKind: CHANGE_KIND[changed.status] ?? FileChangeKind.MODIFIED,
    previousPath: changed.previousFilename,
    isBinary: changed.patch === null,
    hunks: parser.parseHunks(changed.patch ?? ""),
  };
}
