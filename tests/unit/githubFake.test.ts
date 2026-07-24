import { describe, expect, it } from "vitest";
import { PullRequestNotFoundError } from "../../src/domain/errors.ts";
import {
  type ExistingReview,
  type ReviewDraft,
  ReviewEvent,
} from "../../src/domain/models/review.ts";
import type { GitHubPort } from "../../src/domain/ports/github.ts";
import { FakeGitHub } from "../../src/infrastructure/github/fake.ts";
import { aChangedFile, aPullRequest } from "../helpers/factories.ts";

describe("FakeGitHub.fetchPullRequest", () => {
  it("throws PullRequestNotFoundError when constructed without a pull request", async () => {
    const fake = new FakeGitHub();

    await expect(fake.fetchPullRequest("octo/hello-world", 42)).rejects.toThrow(
      PullRequestNotFoundError,
    );
  });

  it("returns the configured pull request", async () => {
    const pr = aPullRequest();
    const fake = new FakeGitHub({ pullRequest: pr });

    await expect(fake.fetchPullRequest("octo/hello-world", 42)).resolves.toEqual(pr);
  });

  it("returns the original head SHA on the first fetch and the moved SHA from the second fetch onward", async () => {
    const pr = aPullRequest({ headSha: "original-sha" });
    const fake = new FakeGitHub({ pullRequest: pr, movedHeadSha: "moved-sha" });

    const first = await fake.fetchPullRequest("octo/hello-world", 42);
    const second = await fake.fetchPullRequest("octo/hello-world", 42);
    const third = await fake.fetchPullRequest("octo/hello-world", 42);

    expect(first.headSha).toBe("original-sha");
    expect(second.headSha).toBe("moved-sha");
    expect(third.headSha).toBe("moved-sha");
  });

  it("returns a stable head SHA across repeated fetches when movedHeadSha is not set", async () => {
    const pr = aPullRequest({ headSha: "stable-sha" });
    const fake = new FakeGitHub({ pullRequest: pr });

    const first = await fake.fetchPullRequest("octo/hello-world", 42);
    const second = await fake.fetchPullRequest("octo/hello-world", 42);

    expect(first.headSha).toBe("stable-sha");
    expect(second.headSha).toBe("stable-sha");
  });
});

describe("FakeGitHub.fetchChangedFiles", () => {
  it("returns an empty array by default", async () => {
    const fake: GitHubPort = new FakeGitHub();

    await expect(fake.fetchChangedFiles("octo/hello-world", 42)).resolves.toEqual([]);
  });

  it("returns the configured changed files", async () => {
    const files = [aChangedFile()];
    const fake: GitHubPort = new FakeGitHub({ changedFiles: files });

    await expect(fake.fetchChangedFiles("octo/hello-world", 42)).resolves.toEqual(files);
  });
});

describe("FakeGitHub.fetchFileContent", () => {
  it("returns the configured content for a known path", async () => {
    const fake: GitHubPort = new FakeGitHub({
      fileContents: { "app/db.ts": "export const x = 1;" },
    });

    await expect(fake.fetchFileContent("octo/hello-world", "app/db.ts", "sha")).resolves.toBe(
      "export const x = 1;",
    );
  });

  it("returns null for an unknown path", async () => {
    const fake: GitHubPort = new FakeGitHub({
      fileContents: { "app/db.ts": "export const x = 1;" },
    });

    await expect(
      fake.fetchFileContent("octo/hello-world", "unknown.ts", "sha"),
    ).resolves.toBeNull();
  });

  it("returns null by default when no file contents are configured", async () => {
    const fake: GitHubPort = new FakeGitHub();

    await expect(fake.fetchFileContent("octo/hello-world", "app/db.ts", "sha")).resolves.toBeNull();
  });
});

describe("FakeGitHub.listReviews", () => {
  it("returns an empty array by default", async () => {
    const fake: GitHubPort = new FakeGitHub();

    await expect(fake.listReviews("octo/hello-world", 42)).resolves.toEqual([]);
  });

  it("returns the configured reviews", async () => {
    const reviews: readonly ExistingReview[] = [{ id: 1, author: "octocat", body: "LGTM" }];
    const fake: GitHubPort = new FakeGitHub({ reviews });

    await expect(fake.listReviews("octo/hello-world", 42)).resolves.toEqual(reviews);
  });
});

describe("FakeGitHub.publishReview", () => {
  it("records the draft in `published` and returns incrementing ids starting at 1000", async () => {
    const fake = new FakeGitHub();
    const first: ReviewDraft = {
      summary: "First review",
      event: ReviewEvent.COMMENT,
      commitId: "sha1",
      inlineComments: [],
    };
    const second: ReviewDraft = {
      summary: "Second review",
      event: ReviewEvent.REQUEST_CHANGES,
      commitId: "sha2",
      inlineComments: [],
    };

    const firstId = await fake.publishReview("octo/hello-world", 42, first);
    const secondId = await fake.publishReview("octo/hello-world", 42, second);

    expect(firstId).toBe(1000);
    expect(secondId).toBe(1001);
    expect(fake.published).toEqual([first, second]);
  });
});

describe("FakeGitHub defaults", () => {
  it("starts with no files, reviews or contents", async () => {
    const github = new FakeGitHub();

    expect(await github.fetchChangedFiles()).toEqual([]);
    expect(await github.listReviews()).toEqual([]);
    expect(await github.fetchFileContent("octo/repo", "missing.ts")).toBeNull();
  });
});
