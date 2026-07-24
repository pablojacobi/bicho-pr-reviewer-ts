/** Port for reading a pull request and publishing a review on GitHub. */

import type { ChangedFile, PullRequest } from "../models/pullRequest.ts";
import type { ExistingReview, ReviewDraft } from "../models/review.ts";

/** Reads PR metadata, files, and reviews, and publishes a single review. */
export interface GitHubPort {
  fetchPullRequest(repository: string, num: number): Promise<PullRequest>;

  fetchChangedFiles(repository: string, num: number): Promise<readonly ChangedFile[]>;

  /** The file's content at `ref`, or `null` if absent, too large, or binary. */
  fetchFileContent(repository: string, path: string, ref: string): Promise<string | null>;

  listReviews(repository: string, num: number): Promise<readonly ExistingReview[]>;

  /** Publish one review and return its id. */
  publishReview(repository: string, num: number, draft: ReviewDraft): Promise<number>;
}
