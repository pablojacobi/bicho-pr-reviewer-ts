/**
 * The typed graph state.
 *
 * Only the reducer-backed key (`outcomes`) may be written by parallel analyzer nodes; every other
 * key is written by a single node on the linear spine. That is what keeps the parallel superstep
 * valid — two branches writing the same last-value channel in one superstep is a conflict.
 */

import { Annotation } from "@langchain/langgraph";
import type { AnalyzerOutcome } from "../../domain/models/analysis.ts";
import type { NormalizedDiff } from "../../domain/models/diff.ts";
import type { Finding } from "../../domain/models/finding.ts";
import type { ChangedFile, PullRequest } from "../../domain/models/pullRequest.ts";
import type { ReviewDraft, ReviewRequest, ReviewStatus } from "../../domain/models/review.ts";
import type { LanguageAdapter } from "../../domain/ports/languageAdapter.ts";

export const ReviewStateAnnotation = Annotation.Root({
  request: Annotation<ReviewRequest>(),

  /** The only key parallel (analyzer) nodes write — accumulated by concatenation. */
  outcomes: Annotation<AnalyzerOutcome[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  // Single-writer keys, populated by the linear spine.
  pullRequest: Annotation<PullRequest | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  changedFiles: Annotation<readonly ChangedFile[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  diff: Annotation<NormalizedDiff>({
    reducer: (_left, right) => right,
    default: () => ({ files: [] }),
  }),
  language: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  adapter: Annotation<LanguageAdapter | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  fileContents: Annotation<ReadonlyMap<string, string>>({
    reducer: (_left, right) => right,
    default: () => new Map(),
  }),
  selected: Annotation<string[]>({ reducer: (_left, right) => right, default: () => [] }),
  findings: Annotation<readonly Finding[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  reviewDraft: Annotation<ReviewDraft | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  /** Set by the publish guards/node: the terminal outcome, and the id of a published review. */
  decision: Annotation<ReviewStatus | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  publishedReviewId: Annotation<number | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

export type ReviewState = typeof ReviewStateAnnotation.State;
export type ReviewStateUpdate = typeof ReviewStateAnnotation.Update;

/**
 * Read a spine-populated value that graph ordering guarantees is present.
 *
 * The Python original relied on `NotRequired` TypedDict keys and read them directly, accepting a
 * `KeyError` if the ordering were ever broken. This is the same contract made explicit: a null here
 * means the graph was rewired incorrectly, which is a programming error, not a runtime condition.
 */
export function required<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`graph invariant violated: ${name} was not populated by an earlier node`);
  }
  return value;
}
