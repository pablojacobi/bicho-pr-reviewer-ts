/**
 * The composition root, exercised through a real review.
 *
 * Everything above `Container` depends on ports, so this is the only place that knows every
 * concrete type — which makes "it constructs" a weak assertion. Instead these tests run an actual
 * dry-run review through the wiring the container produces, with GitHub and the model endpoint
 * intercepted at the HTTP layer and the subprocess runner faked. Nothing here reaches the network
 * or a real binary, but every adapter in the chain is the production one.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Container } from "../../src/api/container.ts";
import { WORKFLOW_VERSION } from "../../src/application/graph/compose.ts";
import { loadSettings } from "../../src/config/settings.ts";
import { parseMarker } from "../../src/domain/models/marker.ts";
import {
  makeReviewOptions,
  type ReviewRequest,
  ReviewTrigger,
} from "../../src/domain/models/review.ts";
import { FixedClock } from "../../src/infrastructure/clock.ts";
import { TempWorkspaceFactory } from "../../src/infrastructure/fs/workspace.ts";
import { SequentialIdGenerator } from "../../src/infrastructure/ids.ts";
import { FakeSubprocessRunner, processResult } from "../../src/infrastructure/process/fake.ts";
import { PKCS1_PEM } from "../helpers/keys.ts";

const GITHUB = "https://api.github.com";
const LLM = "https://llm.test/v1";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const request: ReviewRequest = {
  repository: "octo/hello-world",
  prNumber: 42,
  installationId: null,
  headShaHint: null,
  trigger: ReviewTrigger.MANUAL,
};

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BICHO_LOG_LEVEL: "fatal",
    BICHO_GITHUB__APP_ID: "1",
    BICHO_GITHUB__PRIVATE_KEY: PKCS1_PEM,
    BICHO_GITHUB__INSTALLATION_ID: "99",
    BICHO_LLM__ACTIVE: "test",
    BICHO_LLM__PROVIDERS__TEST__API_KEY: "k",
    BICHO_LLM__PROVIDERS__TEST__BASE_URL: LLM,
    BICHO_LLM__PROVIDERS__TEST__MODEL: "test-model",
    BICHO_SCANNER__SEMGREP_ENABLED: "false",
    BICHO_SCANNER__NPM_AUDIT_ENABLED: "false",
    ...overrides,
  };
}

/** One finding, returned the way an OpenAI-compatible endpoint returns a tool call. */
function chatCompletion(findings: unknown[]) {
  return HttpResponse.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "report_findings",
                arguments: JSON.stringify({ findings }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

const aRawFinding = {
  title: "Unvalidated input reaches the query",
  explanation: "The value is interpolated straight into SQL.",
  impact: "An attacker can read arbitrary rows.",
  recommendation: "Use a parameterized query.",
  path: "app/db.ts",
  startLine: 11,
  endLine: 11,
  severity: "high",
  confidence: "high",
  subcategory: "sql-injection",
  snippet: "db.query(`SELECT ${id}`)",
};

/** Intercept the whole outward surface: token minting, the PR, its files, and the model. */
function stubUpstream(options: { findings?: unknown[] } = {}) {
  const modelCalls: string[] = [];
  server.use(
    http.post(`${GITHUB}/app/installations/:id/access_tokens`, () =>
      HttpResponse.json({
        token: "ghs_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ),
    http.get(`${GITHUB}/repos/:owner/:repo/pulls/:num`, () =>
      HttpResponse.json({
        number: 42,
        title: "Add a thing",
        body: null,
        draft: false,
        user: { login: "octocat" },
        head: { sha: "headsha" },
        base: { ref: "main", repo: { full_name: "octo/hello-world" } },
      }),
    ),
    http.get(`${GITHUB}/repos/:owner/:repo/pulls/:num/files`, () =>
      HttpResponse.json([
        {
          filename: "app/db.ts",
          status: "modified",
          patch: "@@ -10,2 +10,3 @@\n ctx\n-old\n+new_a\n+new_b",
          additions: 2,
          deletions: 1,
        },
      ]),
    ),
    http.get(`${GITHUB}/repos/:owner/:repo/contents/*`, () =>
      HttpResponse.text("export function load(id: string) {\n  return id;\n}\n"),
    ),
    http.post(`${LLM}/chat/completions`, async ({ request: httpRequest }) => {
      modelCalls.push(String(((await httpRequest.json()) as { model?: unknown }).model));
      return chatCompletion(options.findings ?? []);
    }),
  );
  return { modelCalls };
}

function aContainer(env: NodeJS.ProcessEnv = baseEnv(), runner = new FakeSubprocessRunner()) {
  return new Container(loadSettings(env), {
    clock: new FixedClock(new Date("2026-01-01T12:00:00Z")),
    ids: new SequentialIdGenerator("run"),
    subprocessRunner: runner,
    workspace: new TempWorkspaceFactory(),
  });
}

describe("Container service caching", () => {
  it("returns the same service for the same installation", () => {
    const container = aContainer();

    expect(container.reviewService(7)).toBe(container.reviewService(7));
  });

  it("builds a separate service per installation, so tokens are minted per installation", () => {
    const container = aContainer();

    expect(container.reviewService(7)).not.toBe(container.reviewService(8));
  });

  it("falls back to the configured installation when none is given", () => {
    const container = aContainer();

    expect(container.reviewService()).toBe(container.reviewService(99));
    expect(container.reviewService(null)).toBe(container.reviewService(99));
  });
});

describe("a review through the assembled pipeline", () => {
  it("runs end to end and composes a draft from a model finding", async () => {
    const { modelCalls } = stubUpstream({ findings: [aRawFinding] });

    const result = await aContainer()
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe("dry_run");
    expect(result.draft?.inlineComments[0]).toMatchObject({ path: "app/db.ts", line: 11 });
    expect(result.draft?.commitId).toBe("headsha");
    // Six LLM analyzer roles, each reaching the configured provider.
    expect(modelCalls).toHaveLength(6);
    expect(new Set(modelCalls)).toEqual(new Set(["test-model"]));
    // Each role reports under its own category, so these are six distinct findings rather than one
    // deduplicated finding: a fingerprint includes the category.
    expect(result.confirmedCount).toBe(6);
  });

  it("reports no confirmed issues when the model finds nothing", async () => {
    stubUpstream({ findings: [] });

    const result = await aContainer()
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    expect(result.confirmedCount).toBe(0);
    expect(result.draft?.summary).toContain("No confirmed issues found.");
  });

  it("stamps the idempotency marker with the analyzed head SHA", async () => {
    stubUpstream({ findings: [] });

    const result = await aContainer()
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    const marker = parseMarker(result.draft?.summary ?? "");

    expect(marker).not.toBeNull();
    expect(marker?.headSha).toBe("headsha");
    expect(marker?.workflowVersion).toBe(WORKFLOW_VERSION);
  });
});

describe("scanner wiring", () => {
  it("runs the deterministic scanners when they are enabled", async () => {
    stubUpstream({ findings: [] });
    const runner = new FakeSubprocessRunner(
      processResult({ stdout: Buffer.from(JSON.stringify({ results: [] })) }),
    );
    const env = baseEnv({
      BICHO_SCANNER__SEMGREP_ENABLED: "true",
      BICHO_SCANNER__NPM_AUDIT_ENABLED: "true",
    });

    const result = await aContainer(env, runner)
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    expect(result.status).toBe("dry_run");
    // Semgrep ran against the materialized workspace; npm audit found no lockfile to audit.
    expect(runner.commands.map((command) => command[0])).toContain("semgrep");
  });

  it("omits the scanners entirely when they are disabled", async () => {
    stubUpstream({ findings: [] });
    const runner = new FakeSubprocessRunner();

    await aContainer(baseEnv(), runner)
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    expect(runner.commands).toEqual([]);
  });
});

describe("verifier wiring", () => {
  it("uses the deterministic policy by default", async () => {
    stubUpstream({ findings: [aRawFinding] });

    const result = await aContainer()
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    // The policy confirms high-confidence findings without any extra model call: six analyzer
    // calls and no seventh, verifying pass.
    expect(result.confirmedCount).toBe(6);
  });

  it("adds the batched verifier call when it is enabled", async () => {
    const { modelCalls } = stubUpstream({ findings: [aRawFinding] });
    const env = baseEnv({ BICHO_VERIFIER_ENABLED: "true" });

    await aContainer(env)
      .reviewService()
      .run(request, makeReviewOptions({ dryRun: true }));

    // Six analyzers plus one batched verification pass.
    expect(modelCalls).toHaveLength(7);
  });
});

describe("Container", () => {
  it("builds its own system adapters when none are injected", () => {
    const container = new Container(loadSettings({ BICHO_GITHUB__INSTALLATION_ID: "5" }));

    // Construction is inert — no clock read, no subprocess, no network — so this only proves the
    // production defaults are constructible and reachable.
    expect(container.reviewService()).toBe(container.reviewService(5));
  });
});
