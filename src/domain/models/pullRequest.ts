/** Pull request metadata. */

/** The metadata Bicho needs about a pull request; its diff is a separate `NormalizedDiff`. */
export interface PullRequest {
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly author: string;
  readonly installationId: number | null;
}

/** A file changed in a PR, as returned by GitHub's "list pull request files" endpoint. */
export interface ChangedFile {
  readonly filename: string;
  readonly status: string;
  /** `null` for binary files, which GitHub returns without a patch. */
  readonly patch: string | null;
  readonly previousFilename: string | null;
  readonly additions: number;
  readonly deletions: number;
}
