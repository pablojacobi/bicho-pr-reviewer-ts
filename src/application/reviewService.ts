/**
 * The single review use case, shared by the manual endpoint and the webhook.
 *
 * Both paths call {@link ReviewService.run}; the only per-path difference is the `ReviewOptions`
 * (dryRun/force/focus/categories) and the trigger recorded on the request. There is no duplicated
 * orchestration — one graph, one code path.
 */

import { isConfirmed } from "../domain/models/finding.ts";
import type { ReviewOptions, ReviewRequest, ReviewResult } from "../domain/models/review.ts";
import { ReviewStatus } from "../domain/models/review.ts";
import type { DiffParserPort } from "../domain/ports/diffParser.ts";
import type { GitHubPort } from "../domain/ports/github.ts";
import type { LanguageAdapterRegistry } from "../domain/ports/languageAdapter.ts";
import type { IdGenerator } from "../domain/ports/system.ts";
import type { Analyzer } from "./analyzers/base.ts";
import type { ReviewContext } from "./context.ts";
import { type ReviewGraph, runGraph } from "./graph/builder.ts";
import { required } from "./graph/state.ts";
import { type FindingVerifier, PolicyVerifier } from "./verifier.ts";

/** Runs the review graph for a pull request and returns a typed result. */
export class ReviewService {
  readonly #graph: ReviewGraph;
  readonly #github: GitHubPort;
  readonly #diffParser: DiffParserPort;
  readonly #adapters: LanguageAdapterRegistry;
  readonly #analyzers: ReadonlyMap<string, Analyzer>;
  readonly #ids: IdGenerator;
  readonly #verifier: FindingVerifier;
  readonly #timeoutSeconds: number | null;

  constructor(options: {
    graph: ReviewGraph;
    github: GitHubPort;
    diffParser: DiffParserPort;
    adapters: LanguageAdapterRegistry;
    analyzers: ReadonlyMap<string, Analyzer>;
    ids: IdGenerator;
    verifier?: FindingVerifier;
    timeoutSeconds?: number | null;
  }) {
    this.#graph = options.graph;
    this.#github = options.github;
    this.#diffParser = options.diffParser;
    this.#adapters = options.adapters;
    this.#analyzers = options.analyzers;
    this.#ids = options.ids;
    this.#verifier = options.verifier ?? new PolicyVerifier();
    this.#timeoutSeconds = options.timeoutSeconds ?? null;
  }

  /** Run the full review pipeline: analyze, compose, and (unless dry-run) publish. */
  async run(request: ReviewRequest, options: ReviewOptions): Promise<ReviewResult> {
    const context: ReviewContext = {
      github: this.#github,
      diffParser: this.#diffParser,
      adapters: this.#adapters,
      analyzers: this.#analyzers,
      verifier: this.#verifier,
      options,
      correlationId: this.#ids.newId(),
    };
    const signal =
      this.#timeoutSeconds === null ? undefined : AbortSignal.timeout(this.#timeoutSeconds * 1000);

    let final: Awaited<ReturnType<typeof runGraph>>;
    try {
      final = await runGraph(this.#graph, { request }, context, signal);
    } catch (error) {
      // A total-run backstop: the review exceeded its deadline (e.g. a slow/flaky model). End
      // cleanly as FAILED rather than hanging a background task; the next event can retry. Any
      // other failure is a real bug and propagates to the caller, which logs it.
      if (signal?.aborted === true) {
        return failed();
      }
      throw error;
    }

    const findings = final.findings;
    return {
      // Every terminal path through the graph sets a decision: the idempotency guard, the
      // stale-head guard, or the publish node. A null here means the graph was rewired wrongly.
      status: required(final.decision, "decision"),
      draft: final.reviewDraft,
      confirmedCount: findings.filter(isConfirmed).length,
      totalCount: findings.length,
      reviewId: final.publishedReviewId,
    };
  }
}

function failed(): ReviewResult {
  return {
    status: ReviewStatus.FAILED,
    draft: null,
    confirmedCount: 0,
    totalCount: 0,
    reviewId: null,
  };
}
