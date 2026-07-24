/**
 * End-to-end tests of the HTTP boundary.
 *
 * The app is built with a stub composition root, so these exercise the real Fastify wiring — the
 * content-type parser that hands the webhook raw bytes, signature verification, event filtering,
 * and background scheduling — without any network, credentials, or model calls.
 */

import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.ts";
import type { Container } from "../../src/api/container.ts";
import type { ReviewService } from "../../src/application/reviewService.ts";
import { loadSettings, type Settings } from "../../src/config/settings.ts";
import type { ReviewOptions, ReviewRequest } from "../../src/domain/models/review.ts";
import { ReviewStatus } from "../../src/domain/models/review.ts";

const SECRET = "webhook-secret";

const configuredEnv: NodeJS.ProcessEnv = {
  BICHO_ENVIRONMENT: "test",
  BICHO_LOG_LEVEL: "fatal",
  BICHO_GITHUB__APP_ID: "1",
  BICHO_GITHUB__PRIVATE_KEY: "pem",
  BICHO_GITHUB__INSTALLATION_ID: "99",
  BICHO_GITHUB__WEBHOOK_SECRET: SECRET,
  BICHO_LLM__ACTIVE: "minimax",
  BICHO_LLM__PROVIDERS__MINIMAX__API_KEY: "k",
  BICHO_LLM__PROVIDERS__MINIMAX__BASE_URL: "https://api.minimax.io/v1",
  BICHO_LLM__PROVIDERS__MINIMAX__MODEL: "minimax-m3",
};

/** Records what the API asked the review pipeline to do, without running any of it. */
function stubContainer() {
  const runs: { request: ReviewRequest; options: ReviewOptions }[] = [];
  const askedFor: (number | null | undefined)[] = [];
  const service = {
    run: async (request: ReviewRequest, options: ReviewOptions) => {
      runs.push({ request, options });
      return {
        status: options.dryRun ? ReviewStatus.DRY_RUN : ReviewStatus.COMPLETED,
        draft: {
          summary: "## Bicho PR Review\n\nNo confirmed issues found.",
          event: "COMMENT" as const,
          commitId: "headsha",
          inlineComments: [],
        },
        confirmedCount: 0,
        totalCount: 0,
        reviewId: options.dryRun ? null : 1000,
      };
    },
  } as unknown as ReviewService;
  const container = {
    reviewService: (installationId?: number | null) => {
      askedFor.push(installationId);
      return service;
    },
  } as unknown as Container;
  return { container, runs, askedFor };
}

let app: FastifyInstance | null = null;

async function buildApp(env: NodeJS.ProcessEnv = configuredEnv) {
  const stub = stubContainer();
  const settings: Settings = loadSettings(env);
  app = await createApp({ settings, container: stub.container });
  return { app, ...stub };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function webhookBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    number: 42,
    pull_request: { number: 42, draft: false, head: { sha: "headsha" } },
    repository: { full_name: "octo/hello-world" },
    installation: { id: 7 },
    ...overrides,
  });
}

describe("health endpoints", () => {
  it("reports liveness", async () => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports readiness when the required configuration is present", async () => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("reports 503 with the missing pieces when configuration is incomplete", async () => {
    const { app: instance } = await buildApp({ BICHO_LOG_LEVEL: "fatal" });

    const response = await instance.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("not_ready");
    expect(response.json().problems.length).toBeGreaterThan(0);
  });

  it("reports the versions stamped into review markers", async () => {
    const { app: instance } = await buildApp();

    const body = (await instance.inject({ method: "GET", url: "/version" })).json();

    expect(body).toMatchObject({ workflowVersion: expect.any(String) });
    expect(body.promptVersion).toBeTruthy();
    expect(body.version).toBeTruthy();
  });
});

describe("POST /reviews", () => {
  it("runs a dry run by default and returns the composed draft", async () => {
    const { app: instance, runs } = await buildApp();

    const response = await instance.inject({
      method: "POST",
      url: "/reviews",
      payload: { repository: "octo/hello-world", prNumber: 42 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe(ReviewStatus.DRY_RUN);
    expect(response.json().draft.summary).toContain("Bicho PR Review");
    expect(runs[0]?.options.dryRun).toBe(true);
    expect(runs[0]?.request.trigger).toBe("manual");
  });

  it("publishes when dryRun is explicitly false", async () => {
    const { app: instance, runs } = await buildApp();

    const response = await instance.inject({
      method: "POST",
      url: "/reviews",
      payload: { repository: "octo/hello-world", prNumber: 42, dryRun: false },
    });

    expect(response.json().status).toBe(ReviewStatus.COMPLETED);
    expect(response.json().reviewId).toBe(1000);
    expect(runs[0]?.options.dryRun).toBe(false);
  });

  it("passes force, focus and categories through to the review options", async () => {
    const { app: instance, runs } = await buildApp();

    await instance.inject({
      method: "POST",
      url: "/reviews",
      payload: {
        repository: "octo/hello-world",
        prNumber: 42,
        force: true,
        focus: "the new query builder",
        categories: ["security"],
      },
    });

    expect(runs[0]?.options).toMatchObject({
      force: true,
      focus: "the new query builder",
      categories: ["security"],
    });
  });

  it("selects the review service for the requested installation", async () => {
    const { app: instance, askedFor } = await buildApp();

    await instance.inject({
      method: "POST",
      url: "/reviews",
      payload: { repository: "octo/hello-world", prNumber: 42, installationId: 123 },
    });

    expect(askedFor).toContain(123);
  });

  it.each([
    ["a missing repository", { prNumber: 42 }],
    ["a missing pull request number", { repository: "octo/hello-world" }],
    ["a pull request number below one", { repository: "octo/hello-world", prNumber: 0 }],
    ["a non-numeric pull request number", { repository: "octo/hello-world", prNumber: "x" }],
  ])("rejects %s", async (_case, payload) => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({ method: "POST", url: "/reviews", payload });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /webhooks/github", () => {
  const headers = (body: string, overrides: Record<string, string> = {}) => ({
    "content-type": "application/json",
    "x-hub-signature-256": sign(body),
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
    ...overrides,
  });

  it("accepts a signed, reviewable event and schedules the review", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody();

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });
    await instance.reviewRunner.drain();

    expect(response.statusCode).toBe(202);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.request).toMatchObject({
      repository: "octo/hello-world",
      prNumber: 42,
      installationId: 7,
      headShaHint: "headsha",
      trigger: "webhook",
    });
    expect(runs[0]?.options.dryRun).toBe(false);
  });

  it("rejects a request with no signature", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody();

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(runs).toHaveLength(0);
  });

  it("rejects a request whose signature does not match the body", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody();

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(webhookBody({ action: "closed" })),
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(runs).toHaveLength(0);
  });

  it("verifies the signature over the raw bytes, not a re-serialization", async () => {
    // Key order and spacing differ from anything JSON.stringify would produce; the signature is
    // still valid because it is computed over exactly these bytes.
    const { app: instance } = await buildApp();
    const body =
      '{ "installation": {"id": 7},  "action":"opened",\n' +
      '  "repository": {"full_name":"octo/hello-world"},\n' +
      '  "pull_request": {"number":42,"draft":false,"head":{"sha":"headsha"}} }';

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });

    expect(response.statusCode).toBe(202);
  });

  it("ignores an event that is not a pull request", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody();

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body, { "x-github-event": "issues" }),
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(runs).toHaveLength(0);
  });

  it.each(["closed", "labeled", "assigned"])("ignores the %s action", async (action) => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody({ action });

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(runs).toHaveLength(0);
  });

  it.each(["opened", "reopened", "synchronize", "ready_for_review"])(
    "reviews on the %s action",
    async (action) => {
      const { app: instance, runs } = await buildApp();
      const body = webhookBody({ action });

      const response = await instance.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: headers(body),
        payload: body,
      });
      await instance.reviewRunner.drain();

      expect(response.statusCode).toBe(202);
      expect(runs).toHaveLength(1);
    },
  );

  it("ignores a draft pull request", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody({
      pull_request: { number: 42, draft: true, head: { sha: "headsha" } },
    });

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(runs).toHaveLength(0);
  });

  it("acknowledges a redelivery without reviewing twice", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody();

    const first = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });
    const second = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });
    await instance.reviewRunner.drain();

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(runs).toHaveLength(1);
  });

  it("still schedules when no delivery id is supplied", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody();
    const { "x-github-delivery": _omitted, ...withoutDelivery } = headers(body);

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: withoutDelivery,
      payload: body,
    });
    await instance.reviewRunner.drain();

    expect(response.statusCode).toBe(202);
    expect(runs).toHaveLength(1);
  });

  it("rejects a correctly signed body that is not valid JSON", async () => {
    const { app: instance, runs } = await buildApp();
    const body = "not json at all";

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("treats a payload with no installation as having none", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody({ installation: undefined });

    await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });
    await instance.reviewRunner.drain();

    expect(runs[0]?.request.installationId).toBeNull();
  });

  it("treats a pull request with no head sha as having no hint", async () => {
    const { app: instance, runs } = await buildApp();
    const body = webhookBody({ pull_request: { number: 42, draft: false } });

    await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(body),
      payload: body,
    });
    await instance.reviewRunner.drain();

    expect(runs[0]?.request.headShaHint).toBeNull();
  });
});

describe("OpenAPI", () => {
  it("serializes a schema describing every route", async () => {
    const { app: instance } = await buildApp();

    const schema = JSON.parse(JSON.stringify(instance.swagger()));

    expect(Object.keys(schema.paths)).toEqual(
      expect.arrayContaining(["/healthz", "/readyz", "/version", "/reviews", "/webhooks/github"]),
    );
  });
});
