/**
 * A configurable {@link GitHubPort} fake for tests and offline runs.
 *
 * Pre-load it with a pull request, changed files, and existing reviews. It records published reviews
 * and hands out incrementing review ids, so the pipeline runs end-to-end without hitting GitHub.
 */

import { PullRequestNotFoundError } from "../../domain/errors.ts";
import type { ChangedFile, PullRequest } from "../../domain/models/pullRequest.ts";
import type { ExistingReview, ReviewDraft } from "../../domain/models/review.ts";
import type { GitHubPort } from "../../domain/ports/github.ts";

/** An in-memory {@link GitHubPort} implementation. */
export class FakeGitHub implements GitHubPort {
  readonly published: ReviewDraft[] = [];
  readonly #pullRequest: PullRequest | null;
  readonly #changedFiles: readonly ChangedFile[];
  readonly #reviews: readonly ExistingReview[];
  readonly #fileContents: ReadonlyMap<string, string>;
  readonly #movedHeadSha: string | null;
  #fetchCount = 0;
  #nextReviewId = 1000;

  constructor(
    options: {
      pullRequest?: PullRequest | null;
      changedFiles?: readonly ChangedFile[];
      reviews?: readonly ExistingReview[];
      fileContents?: Readonly<Record<string, string>>;
      /**
       * When set, the second and later fetches report this head SHA, simulating a push that lands
       * between analysis and publishing (exercises the stale-head guard).
       */
      movedHeadSha?: string | null;
    } = {},
  ) {
    this.#pullRequest = options.pullRequest ?? null;
    this.#changedFiles = options.changedFiles ?? [];
    this.#reviews = options.reviews ?? [];
    this.#fileContents = new Map(Object.entries(options.fileContents ?? {}));
    this.#movedHeadSha = options.movedHeadSha ?? null;
  }

  async fetchPullRequest(repository: string, num: number): Promise<PullRequest> {
    if (this.#pullRequest === null) {
      throw new PullRequestNotFoundError(`${repository}#${num}`);
    }
    this.#fetchCount += 1;
    if (this.#movedHeadSha !== null && this.#fetchCount > 1) {
      return { ...this.#pullRequest, headSha: this.#movedHeadSha };
    }
    return this.#pullRequest;
  }

  async fetchChangedFiles(): Promise<readonly ChangedFile[]> {
    return this.#changedFiles;
  }

  async fetchFileContent(_repository: string, path: string): Promise<string | null> {
    return this.#fileContents.get(path) ?? null;
  }

  async listReviews(): Promise<readonly ExistingReview[]> {
    return this.#reviews;
  }

  async publishReview(_repository: string, _num: number, draft: ReviewDraft): Promise<number> {
    this.published.push(draft);
    const reviewId = this.#nextReviewId;
    this.#nextReviewId += 1;
    return reviewId;
  }
}
