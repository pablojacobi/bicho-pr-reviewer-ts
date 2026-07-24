/**
 * A `fetch`-backed {@link GitHubPort} using a GitHub App installation token.
 *
 * Constructed per installation: every request carries a fresh-enough installation token from
 * {@link GitHubAppAuth}. Reads the PR, its changed files (paginated), and existing reviews;
 * publishes one review with inline comments (`commit_id` pinned to the analyzed head SHA).
 */

import { GitHubError, PullRequestNotFoundError } from "../../domain/errors.ts";
import type { ChangedFile, PullRequest } from "../../domain/models/pullRequest.ts";
import type { ExistingReview, InlineComment, ReviewDraft } from "../../domain/models/review.ts";
import type { GitHubPort } from "../../domain/ports/github.ts";
import { isProbablyBinary, isSafeRelativePath, isWithinSize } from "../fs/pathsafe.ts";
import type { GitHubAppAuth } from "./auth.ts";

const ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";
const API_VERSION = "2022-11-28";
const HTTP_NOT_FOUND = 404;

/** Reads PRs/files/reviews and publishes a review, authenticated per installation. */
export class GitHubClient implements GitHubPort {
  readonly #auth: GitHubAppAuth;
  readonly #installationId: number;
  readonly #fetch: typeof fetch;
  readonly #apiBase: string;

  constructor(options: {
    auth: GitHubAppAuth;
    installationId: number;
    apiBase?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#auth = options.auth;
    this.#installationId = options.installationId;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await this.#auth.installationToken(this.#installationId);
    return {
      authorization: `Bearer ${token}`,
      accept: ACCEPT,
      "x-github-api-version": API_VERSION,
    };
  }

  async fetchPullRequest(repository: string, num: number): Promise<PullRequest> {
    const response = await this.#fetch(`${this.#apiBase}/repos/${repository}/pulls/${num}`, {
      headers: await this.#headers(),
    });
    if (response.status === HTTP_NOT_FOUND) {
      throw new PullRequestNotFoundError(`${repository}#${num}`);
    }
    assertOk(response, `fetch pull request ${repository}#${num}`);
    return toPullRequest(await response.json(), this.#installationId);
  }

  async fetchChangedFiles(repository: string, num: number): Promise<readonly ChangedFile[]> {
    const files: ChangedFile[] = [];
    let url: string | null = `${this.#apiBase}/repos/${repository}/pulls/${num}/files?per_page=100`;
    while (url !== null) {
      const response: Response = await this.#fetch(url, { headers: await this.#headers() });
      assertOk(response, `list files for ${repository}#${num}`);
      const page = (await response.json()) as unknown[];
      files.push(...page.map(toChangedFile));
      url = nextPage(response.headers.get("link"));
    }
    return files;
  }

  async fetchFileContent(repository: string, path: string, ref: string): Promise<string | null> {
    if (!isSafeRelativePath(path)) {
      return null;
    }
    const url = new URL(`${this.#apiBase}/repos/${repository}/contents/${path}`);
    url.searchParams.set("ref", ref);
    const response = await this.#fetch(url, {
      headers: { ...(await this.#headers()), accept: RAW_ACCEPT },
    });
    if (response.status === HTTP_NOT_FOUND) {
      return null;
    }
    assertOk(response, `fetch ${repository}/${path}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (!isWithinSize(data.byteLength) || isProbablyBinary(data)) {
      return null;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return null; // not valid UTF-8; treat it as unreadable rather than corrupting the analysis
    }
  }

  async listReviews(repository: string, num: number): Promise<readonly ExistingReview[]> {
    const response = await this.#fetch(
      `${this.#apiBase}/repos/${repository}/pulls/${num}/reviews`,
      { headers: await this.#headers() },
    );
    assertOk(response, `list reviews for ${repository}#${num}`);
    return ((await response.json()) as unknown[]).map(toExistingReview);
  }

  async publishReview(repository: string, num: number, draft: ReviewDraft): Promise<number> {
    const response = await this.#fetch(
      `${this.#apiBase}/repos/${repository}/pulls/${num}/reviews`,
      {
        method: "POST",
        headers: { ...(await this.#headers()), "content-type": "application/json" },
        body: JSON.stringify(toReviewPayload(draft)),
      },
    );
    assertOk(response, `publish review on ${repository}#${num}`);
    const data = (await response.json()) as { id?: unknown };
    return Number(data.id);
  }
}

function assertOk(response: Response, action: string): void {
  if (!response.ok) {
    throw new GitHubError(`could not ${action}: ${response.status}`);
  }
}

/** GitHub payloads are snake_case; this is the one place that vocabulary is translated. */
type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return (value ?? {}) as Json;
}

function toPullRequest(data: unknown, installationId: number): PullRequest {
  const pr = asRecord(data);
  const base = asRecord(pr["base"]);
  const repo = asRecord(base["repo"]);
  const head = asRecord(pr["head"]);
  const user = asRecord(pr["user"]);
  return {
    repository: String(repo["full_name"]),
    number: Number(pr["number"]),
    headSha: String(head["sha"]),
    baseRef: String(base["ref"]),
    title: String(pr["title"]),
    body: typeof pr["body"] === "string" ? pr["body"] : "",
    isDraft: pr["draft"] === true,
    author: typeof user["login"] === "string" ? user["login"] : "",
    installationId,
  };
}

function toChangedFile(data: unknown): ChangedFile {
  const file = asRecord(data);
  return {
    filename: String(file["filename"]),
    status: String(file["status"]),
    patch: typeof file["patch"] === "string" ? file["patch"] : null,
    previousFilename:
      typeof file["previous_filename"] === "string" ? file["previous_filename"] : null,
    additions: Number(file["additions"] ?? 0),
    deletions: Number(file["deletions"] ?? 0),
  };
}

function toExistingReview(data: unknown): ExistingReview {
  const review = asRecord(data);
  const user = asRecord(review["user"]);
  return {
    id: Number(review["id"]),
    author: typeof user["login"] === "string" ? user["login"] : "",
    body: typeof review["body"] === "string" ? review["body"] : "",
  };
}

function toReviewPayload(draft: ReviewDraft): Json {
  const payload: Json = {
    commit_id: draft.commitId,
    body: draft.summary,
    event: draft.event,
  };
  if (draft.inlineComments.length > 0) {
    payload["comments"] = draft.inlineComments.map(toCommentPayload);
  }
  return payload;
}

function toCommentPayload(comment: InlineComment): Json {
  const payload: Json = {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
  };
  if (comment.startLine !== null) {
    payload["start_line"] = comment.startLine;
    payload["start_side"] = comment.startSide ?? comment.side;
  }
  return payload;
}

/** Follow GitHub's `Link` header pagination, returning the `rel="next"` URL if there is one. */
export function nextPage(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    // `indexOf`/`slice` (unlike `split(";")` + index access) always return plain strings, so there
    // is no spurious possibly-undefined segment to guard against.
    const separator = part.indexOf(";");
    if (separator === -1) {
      continue;
    }
    const url = part.slice(0, separator).trim().replace(/^<|>$/g, "");
    const rel = part.slice(separator + 1);
    if (rel.includes('rel="next"')) {
      return url;
    }
  }
  return null;
}
