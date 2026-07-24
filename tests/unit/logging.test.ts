import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, loggerOptions, REDACTED } from "../../src/config/logging.ts";
import { loadSettings } from "../../src/config/settings.ts";

/** Capture what a logger actually writes, so redaction is asserted on real output. */
function captureLogs(settings: ReturnType<typeof loadSettings>) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      done();
    },
  });
  return { logger: pino(loggerOptions(settings), stream), lines };
}

const production = loadSettings({ BICHO_ENVIRONMENT: "production" });

describe("loggerOptions", () => {
  it("uses the configured level", () => {
    expect(loggerOptions(loadSettings({ BICHO_LOG_LEVEL: "warn" })).level).toBe("warn");
  });

  it("renders JSON in production, with no pretty transport", () => {
    expect(loggerOptions(production).transport).toBeUndefined();
  });

  it("renders human-readable logs outside production", () => {
    const options = loggerOptions(loadSettings({ BICHO_ENVIRONMENT: "local" }));

    expect(options.transport).toMatchObject({ target: "pino-pretty" });
  });
});

describe("redaction", () => {
  it.each([
    "authorization",
    "token",
    "apiKey",
    "privateKey",
    "secret",
    "webhookSecret",
    "password",
  ])("redacts a top-level %s field", (key) => {
    const { logger, lines } = captureLogs(production);

    logger.info({ [key]: "super-secret-value" }, "event");

    expect(lines[0]?.[key]).toBe(REDACTED);
    expect(JSON.stringify(lines[0])).not.toContain("super-secret-value");
  });

  it("redacts a sensitive field nested one level deep", () => {
    const { logger, lines } = captureLogs(production);

    logger.info({ headers: { authorization: "Bearer ghs_secret" } }, "request");

    expect(JSON.stringify(lines[0])).not.toContain("ghs_secret");
  });

  it("redacts a sensitive field nested two levels deep", () => {
    const { logger, lines } = captureLogs(production);

    logger.info({ settings: { github: { privateKey: "-----BEGIN KEY-----" } } }, "config");

    expect(JSON.stringify(lines[0])).not.toContain("BEGIN KEY");
  });

  it("redacts the webhook signature header", () => {
    const { logger, lines } = captureLogs(production);

    logger.info({ "x-hub-signature-256": "sha256=deadbeef" }, "webhook");

    expect(JSON.stringify(lines[0])).not.toContain("deadbeef");
  });

  it("leaves ordinary fields untouched", () => {
    const { logger, lines } = captureLogs(production);

    logger.info({ repository: "octo/hello-world", prNumber: 42 }, "review_started");

    expect(lines[0]).toMatchObject({ repository: "octo/hello-world", prNumber: 42 });
  });

  it("labels the level by name rather than pino's numeric code", () => {
    const { logger, lines } = captureLogs(production);

    logger.warn("careful");

    expect(lines[0]?.["level"]).toBe("warn");
  });

  it("stamps an ISO timestamp", () => {
    const { logger, lines } = captureLogs(production);

    logger.info("event");

    expect(String(lines[0]?.["time"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("createLogger", () => {
  it("builds a logger at the configured level", () => {
    expect(createLogger(loadSettings({ BICHO_LOG_LEVEL: "error" })).level).toBe("error");
  });
});
