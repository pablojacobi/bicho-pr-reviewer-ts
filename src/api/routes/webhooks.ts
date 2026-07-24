/**
 * GitHub webhook endpoint.
 *
 * Verifies the HMAC signature over the raw body *before* parsing, filters to reviewable
 * `pull_request` actions, de-duplicates redeliveries, then schedules the review off-request and
 * returns 202 at once. The heavy work (LangGraph, the model, publishing) never runs in the request.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  makeReviewOptions,
  type ReviewRequest,
  ReviewTrigger,
} from "../../domain/models/review.ts";
import { verifySignature } from "../security.ts";

export const WEBHOOK_PATH = "/webhooks/github";

const EVENT = "pull_request";
const ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

interface WebhookPayload {
  action?: unknown;
  pull_request?: { number?: unknown; draft?: unknown; head?: { sha?: unknown } };
  repository?: { full_name?: unknown };
  installation?: { id?: unknown };
}

/**
 * Read a request header as a single string.
 *
 * Node only ever hands back an array for `set-cookie`; every other repeated header arrives joined.
 * A non-string value here therefore means "not the header we expect", which is treated exactly like
 * an absent one rather than being guessed at.
 */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    WEBHOOK_PATH,
    { schema: { tags: ["webhooks"], summary: "Receive a GitHub webhook" } },
    async (request, reply) => {
      // The body arrives as a raw Buffer for this route (see the content-type parser in app.ts):
      // the signature covers the exact bytes GitHub sent, so nothing may re-serialize them first.
      const raw = request.body as Buffer;
      const secret = app.settings.github.webhookSecret;
      if (!verifySignature(secret, raw, header(request, "x-hub-signature-256"))) {
        return reply.code(401).send({ message: "invalid signature" });
      }

      if (header(request, "x-github-event") !== EVENT) {
        return reply.code(204).send();
      }

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(raw.toString("utf8")) as WebhookPayload;
      } catch {
        return reply.code(400).send({ message: "invalid JSON body" });
      }

      const reviewRequest = toReviewRequest(payload);
      if (reviewRequest === null) {
        return reply.code(204).send();
      }

      const delivery = header(request, "x-github-delivery");
      if (delivery !== undefined && !app.reviewRunner.deliveries.register(delivery)) {
        return reply.code(202).send();
      }

      app.reviewRunner.schedule(reviewRequest, makeReviewOptions());
      return reply.code(202).send();
    },
  );
}

/**
 * Decide whether a payload describes a pull request worth reviewing, and shape the request.
 *
 * Pure and separate from the handler so the filtering rules read as one list rather than as
 * control flow interleaved with HTTP replies. `null` means "acknowledge and do nothing".
 */
function toReviewRequest(payload: WebhookPayload): ReviewRequest | null {
  if (typeof payload.action !== "string" || !ACTIONS.has(payload.action)) {
    return null;
  }
  const pullRequest = payload.pull_request ?? {};
  if (pullRequest.draft === true) {
    return null;
  }
  // GitHub always sends a number on a pull_request event, but anything that can reach this
  // endpoint can post otherwise. Without this, a missing number would schedule a review for `NaN`
  // that can only fail once it reaches the API.
  const prNumber = Number(pullRequest.number);
  if (!Number.isInteger(prNumber)) {
    return null;
  }
  return {
    repository: String(payload.repository?.full_name),
    prNumber,
    installationId: payload.installation?.id === undefined ? null : Number(payload.installation.id),
    headShaHint: pullRequest.head?.sha === undefined ? null : String(pullRequest.head.sha),
    trigger: ReviewTrigger.WEBHOOK,
  };
}
