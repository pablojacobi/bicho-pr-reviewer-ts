/**
 * Fastify application factory.
 *
 * The app is built by a factory (rather than a module-level singleton) so tests can construct a
 * fresh, isolated instance with its own settings and its own composition root. Everything the
 * routes need is decorated onto the instance, so a route declares what it uses without knowing how
 * it was built — and a test can substitute any of it.
 */

import fastifySwagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import { loggerOptions } from "../config/logging.ts";
import { loadSettings, type Settings } from "../config/settings.ts";
import { BackgroundReviewRunner } from "./background.ts";
import { Container } from "./container.ts";
import { healthRoutes } from "./routes/health.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { WEBHOOK_PATH, webhookRoutes } from "./routes/webhooks.ts";
import { APP_VERSION } from "./version.ts";

declare module "fastify" {
  interface FastifyInstance {
    settings: Settings;
    container: Container;
    reviewRunner: BackgroundReviewRunner;
  }
}

/** Build and configure the Bicho PR Reviewer application. */
export async function createApp(
  options: { settings?: Settings; container?: Container } = {},
): Promise<FastifyInstance> {
  const settings = options.settings ?? loadSettings();
  // Fastify builds the logger from plain pino options, so there is exactly one logging config.
  const app = Fastify({ logger: loggerOptions(settings) });

  const container = options.container ?? new Container(settings);
  const reviewRunner = new BackgroundReviewRunner(container, { logger: app.log });

  app.decorate("settings", settings);
  app.decorate("container", container);
  app.decorate("reviewRunner", reviewRunner);

  /**
   * One JSON parser, two behaviours.
   *
   * The webhook route needs the untouched bytes GitHub signed, so it receives the raw Buffer and
   * verifies the HMAC before parsing anything. Every other route gets ordinary parsed JSON.
   */
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const raw = body as Buffer;
    if (request.url.split("?")[0] === WEBHOOK_PATH) {
      done(null, raw);
      return;
    }
    try {
      done(null, raw.length === 0 ? {} : (JSON.parse(raw.toString("utf8")) as unknown));
    } catch (error) {
      // Fastify's own parser stamps a status on this; a bare SyntaxError would be reported as a
      // 500, blaming the server for what is a malformed request.
      const failure = error as Error & { statusCode?: number };
      failure.statusCode = 400;
      done(failure);
    }
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Bicho PR Reviewer",
        description: "Automated GitHub Pull Request review agent.",
        version: APP_VERSION,
      },
    },
  });

  await app.register(healthRoutes);
  await app.register(reviewRoutes);
  await app.register(webhookRoutes);

  app.addHook("onClose", async () => {
    await reviewRunner.drain();
  });

  await app.ready();
  return app;
}
