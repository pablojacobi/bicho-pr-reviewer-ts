/**
 * Structured logging configuration (pino).
 *
 * Human-readable console output for local/test and JSON for production. Every event passes through
 * a redaction list, so tokens, signatures, and private keys never reach the logs even if a caller
 * attaches them to a log record by accident.
 */

import { type Logger, type LoggerOptions, pino } from "pino";
import { renderJsonLogs, type Settings } from "./settings.ts";

export const REDACTED = "***redacted***";

/**
 * Keys whose values are never safe to log.
 *
 * pino matches redaction paths literally, so each key is registered both at the top level and one
 * level deep (`*.key`), which covers the shapes we actually log (`{ err }`, `{ headers }`, a
 * settings section) without paying for a deep wildcard on every record.
 */
const SENSITIVE_KEYS = [
  "authorization",
  "token",
  "accessToken",
  "access_token",
  "installationToken",
  "installation_token",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
  "secret",
  "webhookSecret",
  "webhook_secret",
  "password",
  "x-hub-signature-256",
] as const;

const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

/**
 * The pino options derived from settings.
 *
 * Exposed separately from {@link createLogger} because Fastify builds its own logger from plain
 * pino options — handing it a constructed instance instead would fork the configuration in two.
 */
export function loggerOptions(settings: Settings): LoggerOptions {
  return {
    level: settings.logLevel,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Emit `level: "info"` rather than pino's default numeric level, matching the original's
      // `add_log_level` processor and keeping production logs readable in a log aggregator.
      level: (label) => ({ level: label }),
    },
    ...(renderJsonLogs(settings)
      ? {}
      : { transport: { target: "pino-pretty", options: { colorize: false } } }),
  };
}

/** Build a standalone application logger from settings. */
export function createLogger(settings: Settings): Logger {
  return pino(loggerOptions(settings));
}
