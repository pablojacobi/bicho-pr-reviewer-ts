/**
 * Health, readiness, and version endpoints.
 *
 * `/healthz` is pure liveness — the process is up and serving, independent of configuration.
 * `/readyz` reports whether required credentials are present, so a misconfigured deploy fails
 * visibly rather than erroring on the first webhook. `/version` exposes the app and
 * workflow/prompt versions recorded in each review marker.
 */

import type { FastifyInstance } from "fastify";
import { WORKFLOW_VERSION } from "../../application/graph/compose.ts";
import { PROMPT_VERSION } from "../../application/prompts/registry.ts";
import { missingRequirements } from "../../config/readiness.ts";
import { APP_VERSION } from "../version.ts";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { schema: { tags: ["health"], summary: "Liveness probe" } }, async () => ({
    status: "ok",
  }));

  app.get(
    "/readyz",
    { schema: { tags: ["health"], summary: "Readiness probe" } },
    async (_request, reply) => {
      const problems = missingRequirements(app.settings);
      if (problems.length > 0) {
        return reply.code(503).send({ status: "not_ready", problems });
      }
      return reply.code(200).send({ status: "ready" });
    },
  );

  app.get("/version", { schema: { tags: ["health"], summary: "Version info" } }, async () => ({
    version: APP_VERSION,
    workflowVersion: WORKFLOW_VERSION,
    promptVersion: PROMPT_VERSION,
  }));
}
