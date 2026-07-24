import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitHubError, PullRequestNotFoundError } from "../../src/domain/errors.ts";
import { DiffSide } from "../../src/domain/models/finding.ts";
import {
  makeInlineComment,
  type ReviewDraft,
  ReviewEvent,
} from "../../src/domain/models/review.ts";
import { FixedClock } from "../../src/infrastructure/clock.ts";
import { GitHubAppAuth } from "../../src/infrastructure/github/auth.ts";
import { GitHubClient, nextPage } from "../../src/infrastructure/github/client.ts";
import { PKCS1_PEM } from "../helpers/keys.ts";

const API = "https://api.github.com";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CLOCK = new FixedClock(new Date("2026-01-01T12:00:00Z"));

/** Mock GitHub's token-minting endpoint so `GitHubAppAuth` can produce a bearer token. */
function tokenEndpoint() {
  return http.post(`${API}/app/installations/:id/access_tokens`, () =>
    HttpResponse.json({
      token: "ghs_installation",
      expires_at: new Date(CLOCK.now().getTime() + 3600_000).toISOString(),
    }),
  );
}

function anAuth(): GitHubAppAuth {
  return new GitHubAppAuth({ appId: "12345", privateKey: PKCS1_PEM, clock: CLOCK, apiBase: API });
}

/** A client wired to a real {@link GitHubAppAuth} whose token endpoint is mocked. */
function aGitHubClient(): GitHubClient {
  server.use(tokenEndpoint());
  return new GitHubClient({ auth: anAuth(), installationId: 7, apiBase: API });
}

/** A pull request payload with just enough fields to map successfully; values don't matter. */
function minimalPullRequestPayload(): Record<string, unknown> {
  return {
    number: 42,
    title: "t",
    body: "",
    user: { login: "a" },
    head: { sha: "s" },
    base: { ref: "main", repo: { full_name: "octo/hello-world" } },
  };
}

function aDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    summary: "Looks fine",
    event: ReviewEvent.COMMENT,
    commitId: "headsha123",
    inlineComments: [],
    ...overrides,
  };
}

describe("GitHubClient construction", () => {
  it("defaults apiBase to GitHub's real API root when omitted", async () => {
    server.use(tokenEndpoint());
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json(minimalPullRequestPayload()),
      ),
    );
    const client = new GitHubClient({ auth: anAuth(), installationId: 7 });

    const pr = await client.fetchPullRequest("octo/hello-world", 42);

    expect(pr.repository).toBe("octo/hello-world");
  });

  it("strips trailing slashes from a custom apiBase", async () => {
    server.use(tokenEndpoint());
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json(minimalPullRequestPayload()),
      ),
    );
    const client = new GitHubClient({ auth: anAuth(), installationId: 7, apiBase: `${API}///` });

    const pr = await client.fetchPullRequest("octo/hello-world", 42);

    expect(pr.repository).toBe("octo/hello-world");
  });

  it("uses a provided fetchImpl instead of the global fetch", async () => {
    server.use(tokenEndpoint());
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json(minimalPullRequestPayload()),
      ),
    );
    let calls = 0;
    const trackedFetch: typeof fetch = async (input, init) => {
      calls += 1;
      return fetch(input, init);
    };
    const client = new GitHubClient({
      auth: anAuth(),
      installationId: 7,
      apiBase: API,
      fetchImpl: trackedFetch,
    });

    await client.fetchPullRequest("octo/hello-world", 42);

    expect(calls).toBe(1);
  });
});

describe("GitHubClient.fetchPullRequest", () => {
  it("maps every field from the GitHub payload", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json({
          number: 42,
          title: "Add a thing",
          body: "Please review",
          draft: true,
          user: { login: "octocat" },
          head: { sha: "headsha123" },
          base: { ref: "main", repo: { full_name: "octo/hello-world" } },
        }),
      ),
    );
    const client = aGitHubClient();

    const pr = await client.fetchPullRequest("octo/hello-world", 42);

    expect(pr).toEqual({
      repository: "octo/hello-world",
      number: 42,
      headSha: "headsha123",
      baseRef: "main",
      title: "Add a thing",
      body: "Please review",
      isDraft: true,
      author: "octocat",
      installationId: 7,
    });
  });

  it("defaults body to empty string when null and author to empty string when user is missing", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json({
          number: 42,
          title: "Add a thing",
          body: null,
          head: { sha: "headsha123" },
          base: { ref: "main", repo: { full_name: "octo/hello-world" } },
        }),
      ),
    );
    const client = aGitHubClient();

    const pr = await client.fetchPullRequest("octo/hello-world", 42);

    expect(pr.body).toBe("");
    expect(pr.author).toBe("");
  });

  it("defaults isDraft to false when draft is absent", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json({
          number: 42,
          title: "Add a thing",
          body: "",
          user: { login: "octocat" },
          head: { sha: "headsha123" },
          base: { ref: "main", repo: { full_name: "octo/hello-world" } },
        }),
      ),
    );
    const client = aGitHubClient();

    const pr = await client.fetchPullRequest("octo/hello-world", 42);

    expect(pr.isDraft).toBe(false);
  });

  it("throws PullRequestNotFoundError on a 404", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const client = aGitHubClient();

    await expect(client.fetchPullRequest("octo/hello-world", 42)).rejects.toThrow(
      PullRequestNotFoundError,
    );
  });

  it("throws GitHubError on a non-OK response", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const client = aGitHubClient();

    await expect(client.fetchPullRequest("octo/hello-world", 42)).rejects.toThrow(GitHubError);
  });

  it("sends the installation bearer token, accept header, and API version", async () => {
    let seenHeaders: Headers | undefined;
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42`, ({ request }) => {
        seenHeaders = request.headers;
        return HttpResponse.json(minimalPullRequestPayload());
      }),
    );
    const client = aGitHubClient();

    await client.fetchPullRequest("octo/hello-world", 42);

    expect(seenHeaders?.get("authorization")).toBe("Bearer ghs_installation");
    expect(seenHeaders?.get("accept")).toBe("application/vnd.github+json");
    expect(seenHeaders?.get("x-github-api-version")).toBe("2022-11-28");
  });
});

describe("GitHubClient.fetchChangedFiles", () => {
  it("maps every field on a single page", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/files`, () =>
        HttpResponse.json([
          {
            filename: "app/db.ts",
            status: "renamed",
            patch: "@@ -1 +1 @@\n-old\n+new",
            previous_filename: "app/database.ts",
            additions: 5,
            deletions: 3,
          },
        ]),
      ),
    );
    const client = aGitHubClient();

    const files = await client.fetchChangedFiles("octo/hello-world", 42);

    expect(files).toEqual([
      {
        filename: "app/db.ts",
        status: "renamed",
        patch: "@@ -1 +1 @@\n-old\n+new",
        previousFilename: "app/database.ts",
        additions: 5,
        deletions: 3,
      },
    ]);
  });

  it("defaults patch to null and previousFilename/additions/deletions when absent", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/files`, () =>
        HttpResponse.json([{ filename: "image.png", status: "added" }]),
      ),
    );
    const client = aGitHubClient();

    const [file] = await client.fetchChangedFiles("octo/hello-world", 42);

    expect(file).toEqual({
      filename: "image.png",
      status: "added",
      patch: null,
      previousFilename: null,
      additions: 0,
      deletions: 0,
    });
  });

  it("follows Link header pagination and returns files from every page", async () => {
    const page2Url = `${API}/repos/octo/hello-world/pulls/42/files?per_page=100&page=2`;
    const requestedUrls: string[] = [];
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/files`, ({ request }) => {
        requestedUrls.push(request.url);
        if (new URL(request.url).searchParams.get("page") === "2") {
          return HttpResponse.json([{ filename: "b.ts", status: "added" }]);
        }
        return HttpResponse.json([{ filename: "a.ts", status: "added" }], {
          headers: { link: `<${page2Url}>; rel="next"` },
        });
      }),
    );
    const client = aGitHubClient();

    const files = await client.fetchChangedFiles("octo/hello-world", 42);

    expect(files.map((file) => file.filename)).toEqual(["a.ts", "b.ts"]);
    expect(requestedUrls).toContain(page2Url);
  });

  it("throws GitHubError on a non-OK response", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/files`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const client = aGitHubClient();

    await expect(client.fetchChangedFiles("octo/hello-world", 42)).rejects.toThrow(GitHubError);
  });
});

describe("GitHubClient.fetchFileContent", () => {
  it("returns the content, sending ref as a query parameter and using the raw accept header", async () => {
    let seenUrl: URL | undefined;
    let seenAccept: string | undefined;
    server.use(
      http.get(`${API}/repos/octo/hello-world/contents/app/db.ts`, ({ request }) => {
        seenUrl = new URL(request.url);
        seenAccept = request.headers.get("accept") ?? undefined;
        return HttpResponse.text("export const x = 1;\n");
      }),
    );
    const client = aGitHubClient();

    const content = await client.fetchFileContent(
      "octo/hello-world",
      "app/db.ts",
      "feature-branch",
    );

    expect(content).toBe("export const x = 1;\n");
    expect(seenUrl?.searchParams.get("ref")).toBe("feature-branch");
    expect(seenAccept).toBe("application/vnd.github.raw+json");
  });

  it("returns null on a 404", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/contents/app/db.ts`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const client = aGitHubClient();

    await expect(
      client.fetchFileContent("octo/hello-world", "app/db.ts", "main"),
    ).resolves.toBeNull();
  });

  it("returns null for an unsafe path without issuing any request", async () => {
    const client = aGitHubClient();
    let requestCount = 0;
    const onRequestStart = () => {
      requestCount += 1;
    };
    server.events.on("request:start", onRequestStart);

    const content = await client.fetchFileContent("octo/hello-world", "../secrets", "main");

    expect(content).toBeNull();
    expect(requestCount).toBe(0);
    server.events.removeListener("request:start", onRequestStart);
  });

  it("returns null for content over the size limit", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/contents/big.txt`, () =>
        HttpResponse.text("a".repeat(1_000_001)),
      ),
    );
    const client = aGitHubClient();

    await expect(
      client.fetchFileContent("octo/hello-world", "big.txt", "main"),
    ).resolves.toBeNull();
  });

  it("returns null for binary content", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/contents/image.png`, () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x89, 0x50, 0x00, 0x47]).buffer),
      ),
    );
    const client = aGitHubClient();

    await expect(
      client.fetchFileContent("octo/hello-world", "image.png", "main"),
    ).resolves.toBeNull();
  });

  it("returns null for invalid UTF-8 content", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/contents/bad.txt`, () =>
        HttpResponse.arrayBuffer(new Uint8Array([0xc3, 0x28]).buffer),
      ),
    );
    const client = aGitHubClient();

    await expect(
      client.fetchFileContent("octo/hello-world", "bad.txt", "main"),
    ).resolves.toBeNull();
  });

  it("throws GitHubError on a non-OK response", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/contents/app/db.ts`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const client = aGitHubClient();

    await expect(client.fetchFileContent("octo/hello-world", "app/db.ts", "main")).rejects.toThrow(
      GitHubError,
    );
  });
});

describe("GitHubClient.listReviews", () => {
  it("maps id, author, and body", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/reviews`, () =>
        HttpResponse.json([{ id: 1, user: { login: "octocat" }, body: "LGTM" }]),
      ),
    );
    const client = aGitHubClient();

    const reviews = await client.listReviews("octo/hello-world", 42);

    expect(reviews).toEqual([{ id: 1, author: "octocat", body: "LGTM" }]);
  });

  it("defaults author to empty string when user is missing and body to empty string when null", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/reviews`, () =>
        HttpResponse.json([{ id: 2, body: null }]),
      ),
    );
    const client = aGitHubClient();

    const reviews = await client.listReviews("octo/hello-world", 42);

    expect(reviews).toEqual([{ id: 2, author: "", body: "" }]);
  });

  it("throws GitHubError on a non-OK response", async () => {
    server.use(
      http.get(`${API}/repos/octo/hello-world/pulls/42/reviews`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const client = aGitHubClient();

    await expect(client.listReviews("octo/hello-world", 42)).rejects.toThrow(GitHubError);
  });
});

describe("GitHubClient.publishReview", () => {
  it("omits the comments field when there are no inline comments", async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 1000 });
      }),
    );
    const client = aGitHubClient();

    await client.publishReview("octo/hello-world", 42, aDraft());

    expect(captured).toEqual({ commit_id: "headsha123", body: "Looks fine", event: "COMMENT" });
    expect(captured).not.toHaveProperty("comments");
  });

  it("includes the comments field when there are inline comments", async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 1000 });
      }),
    );
    const client = aGitHubClient();
    const comment = makeInlineComment({ path: "app/db.ts", line: 10, body: "fix" });

    await client.publishReview("octo/hello-world", 42, aDraft({ inlineComments: [comment] }));

    expect(captured).toHaveProperty("comments");
    expect(captured?.["comments"]).toHaveLength(1);
  });

  it("sends path, line, side, and body for a single-line comment, without start_line", async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 1000 });
      }),
    );
    const client = aGitHubClient();
    const comment = makeInlineComment({
      path: "app/db.ts",
      line: 10,
      body: "fix this",
      side: DiffSide.RIGHT,
    });

    await client.publishReview("octo/hello-world", 42, aDraft({ inlineComments: [comment] }));

    const comments = captured?.["comments"] as Array<Record<string, unknown>>;
    expect(comments[0]).toEqual({ path: "app/db.ts", line: 10, side: "RIGHT", body: "fix this" });
  });

  it("includes start_line and start_side for a multi-line comment", async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 1000 });
      }),
    );
    const client = aGitHubClient();
    const comment = makeInlineComment({
      path: "app/db.ts",
      line: 12,
      startLine: 10,
      startSide: DiffSide.LEFT,
      side: DiffSide.RIGHT,
      body: "multi-line",
    });

    await client.publishReview("octo/hello-world", 42, aDraft({ inlineComments: [comment] }));

    const comments = captured?.["comments"] as Array<Record<string, unknown>>;
    expect(comments[0]?.["start_line"]).toBe(10);
    expect(comments[0]?.["start_side"]).toBe("LEFT");
  });

  it("falls back start_side to side when startSide is not set", async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 1000 });
      }),
    );
    const client = aGitHubClient();
    const comment = makeInlineComment({
      path: "app/db.ts",
      line: 12,
      startLine: 10,
      side: DiffSide.RIGHT,
      body: "multi-line",
    });

    await client.publishReview("octo/hello-world", 42, aDraft({ inlineComments: [comment] }));

    const comments = captured?.["comments"] as Array<Record<string, unknown>>;
    expect(comments[0]?.["start_side"]).toBe("RIGHT");
  });

  it("returns the created review id", async () => {
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, () =>
        HttpResponse.json({ id: 555 }),
      ),
    );
    const client = aGitHubClient();

    const id = await client.publishReview("octo/hello-world", 42, aDraft());

    expect(id).toBe(555);
  });

  it("throws GitHubError on a non-OK response", async () => {
    server.use(
      http.post(`${API}/repos/octo/hello-world/pulls/42/reviews`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const client = aGitHubClient();

    await expect(client.publishReview("octo/hello-world", 42, aDraft())).rejects.toThrow(
      GitHubError,
    );
  });
});

describe("nextPage", () => {
  it.each([
    ["a null header", null],
    ["an empty header", ""],
  ])("returns null for %s", (_case, header) => {
    expect(nextPage(header)).toBeNull();
  });

  it("returns the URL for a rel=next link, with angle brackets stripped", () => {
    const header = '<https://api.github.com/resource?page=2>; rel="next"';

    expect(nextPage(header)).toBe("https://api.github.com/resource?page=2");
  });

  it("finds the rel=next link among several comma-separated links", () => {
    const header =
      '<https://api.github.com/resource?page=1>; rel="prev", <https://api.github.com/resource?page=3>; rel="next"';

    expect(nextPage(header)).toBe("https://api.github.com/resource?page=3");
  });

  it("returns null when only rel=prev and rel=last links are present", () => {
    const header =
      '<https://api.github.com/resource?page=1>; rel="prev", <https://api.github.com/resource?page=9>; rel="last"';

    expect(nextPage(header)).toBeNull();
  });

  it("returns null for a malformed, single-segment part", () => {
    expect(nextPage("not-a-real-link-header")).toBeNull();
  });

  it("returns null for a header with no relation segment", () => {
    expect(nextPage("<https://api.github.com/x>")).toBeNull();
  });

  it("returns null when only earlier pages are linked", () => {
    expect(nextPage('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
  });

  it("extracts the next page from a multi-relation header", () => {
    const header =
      '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"';

    expect(nextPage(header)).toBe("https://api.github.com/x?page=3");
  });

  it("returns null for an empty header", () => {
    expect(nextPage("")).toBeNull();
  });
});
