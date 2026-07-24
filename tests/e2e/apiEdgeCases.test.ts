/**
 * HTTP boundary edge cases.
 *
 * Malformed bodies, repeated headers and payloads missing the fields GitHub always sends: none of
 * these occur on the happy path, and all of them are reachable by anything that can post to the
 * service. The boundary has to answer them without throwing or scheduling work.
 */

import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.ts";
import type { Container } from "../../src/api/container.ts";
import type { ReviewService } from "../../src/application/reviewService.ts";
import { loadSettings } from "../../src/config/settings.ts";
import type { ReviewOptions, ReviewRequest } from "../../src/domain/models/review.ts";
import { ReviewStatus } from "../../src/domain/models/review.ts";

const SECRET = "webhook-secret";
let app: FastifyInstance | null = null;

function stubContainer() {
  const runs: { request: ReviewRequest; options: ReviewOptions }[] = [];
  const service = {
    run: async (request: ReviewRequest, options: ReviewOptions) => {
      runs.push({ request, options });
      return {
        status: ReviewStatus.DRY_RUN,
        draft: null,
        confirmedCount: 0,
        totalCount: 0,
        reviewId: null,
      };
    },
  } as unknown as ReviewService;
  return {
    container: { reviewService: () => service } as unknown as Container,
    runs,
  };
}

async function buildApp() {
  const stub = stubContainer();
  app = await createApp({
    settings: loadSettings({
      BICHO_LOG_LEVEL: "fatal",
      BICHO_GITHUB__WEBHOOK_SECRET: SECRET,
    }),
    container: stub.container,
  });
  return { app, ...stub };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("the JSON content-type parser", () => {
  it("rejects a malformed body on an ordinary route", async () => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({
      method: "POST",
      url: "/reviews",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });

    expect(response.statusCode).toBe(400);
  });

  it("treats an empty body as an empty object, so validation reports the real problem", async () => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({
      method: "POST",
      url: "/reviews",
      headers: { "content-type": "application/json" },
      payload: "",
    });

    // Not a parse error: the body validator is what rejects it, naming the missing fields.
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/repository/);
  });
});

describe("webhook header handling", () => {
  const body = JSON.stringify({
    action: "opened",
    pull_request: { number: 42, draft: false, head: { sha: "headsha" } },
    repository: { full_name: "octo/hello-world" },
    installation: { id: 7 },
  });

  it("ignores a request that carries no event header at all", async () => {
    const { app: instance, runs } = await buildApp();

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    expect(runs).toHaveLength(0);
  });

  it("ignores a pull_request event whose payload carries no pull request", async () => {
    const { app: instance, runs } = await buildApp();
    const withoutPr = JSON.stringify({
      action: "opened",
      repository: { full_name: "octo/hello-world" },
      installation: { id: 7 },
    });

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(withoutPr),
        "x-github-event": "pull_request",
      },
      payload: withoutPr,
    });

    // The action is reviewable but there is nothing to review; schedule nothing.
    expect(response.statusCode).toBe(204);
    expect(runs).toHaveLength(0);
  });

  it("ignores an event with no action at all", async () => {
    const { app: instance, runs } = await buildApp();
    const noAction = JSON.stringify({ pull_request: { number: 42 } });

    const response = await instance.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(noAction),
        "x-github-event": "pull_request",
      },
      payload: noAction,
    });

    expect(response.statusCode).toBe(204);
    expect(runs).toHaveLength(0);
  });
});

describe("createApp defaults", () => {
  it("loads settings from the environment and builds its own composition root", async () => {
    // Nothing injected: this is the shape `main.ts` uses in production. Construction is inert, so
    // it neither reads credentials nor reaches the network. The level keeps the suite's output
    // clean — settings come from the environment on this path, which is the point of the test.
    process.env["BICHO_LOG_LEVEL"] = "fatal";
    const instance = await createApp();
    app = instance;

    const response = await instance.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(instance.settings.environment).toBe("local");
  });
});
