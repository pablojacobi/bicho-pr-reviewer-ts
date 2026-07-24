/**
 * Centralized application configuration.
 *
 * All environment access lives here (and only here): the rest of the codebase depends on a typed,
 * validated `Settings` object rather than reading `process.env` directly. Values are read with the
 * `BICHO_` prefix and a `__` delimiter for nested sections — the exact contract of the Python
 * original, so one deployment environment configures either implementation.
 */

import { z } from "zod";
import { envBoolean, envInteger, envNumber, expandEnv } from "./env.ts";
import { Environment, isProduction } from "./environment.ts";

/** Log levels, in pino's vocabulary. Input is accepted case-insensitively (`INFO` works). */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const logLevelSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(LOG_LEVELS));

/** GitHub App credentials and API base (env: `BICHO_GITHUB__*`). */
export const githubSettingsSchema = z.object({
  appId: z.string().default(""),
  /**
   * PEM contents. An environment variable usually carries the key on a single line with literal
   * `\n` sequences; restore them so the PEM parses.
   */
  privateKey: z
    .string()
    .default("")
    .transform((value) => value.replaceAll("\\n", "\n")),
  installationId: envInteger.default(0),
  apiBase: z.string().default("https://api.github.com"),
  webhookSecret: z.string().default(""),
});
export type GitHubSettings = Readonly<z.output<typeof githubSettingsSchema>>;

/**
 * One OpenAI-compatible model provider (MiniMax, Gemini, OpenAI, a local proxy, …).
 *
 * `maxAttempts` / `retryDelaySeconds` add fixed-delay retries for flaky endpoints. `maxConcurrency`
 * bounds how many calls to this provider run at once across the whole review — set it to 1 to force
 * the analyzers through this provider serially (0 means unbounded / fully parallel). This keeps
 * concurrency a property of the provider config, not a vendor special-case in code.
 */
export const providerSpecSchema = z.object({
  apiKey: z.string().default(""),
  baseUrl: z.string().default(""),
  model: z.string().default(""),
  timeoutSeconds: envNumber.default(60),
  maxAttempts: envInteger.default(1),
  retryDelaySeconds: envNumber.default(0),
  maxConcurrency: envInteger.default(0),
});
export type ProviderSpec = Readonly<z.output<typeof providerSpecSchema>>;

/**
 * Model configuration (env: `BICHO_LLM__*`).
 *
 * Several providers can be configured at once, each under its own name, and `active` selects the
 * one in use — so adding a model (e.g. Gemini) is a new provider block plus flipping `active`,
 * never swapping keys. Every provider is just an OpenAI-compatible endpoint; nothing here is
 * vendor-specific in code.
 */
export const llmSettingsSchema = z.object({
  active: z.string().default("minimax"),
  providers: z.record(z.string(), providerSpecSchema).default({}),
});
export type LLMSettings = Readonly<z.output<typeof llmSettingsSchema>>;

/**
 * Deterministic-scanner configuration (env: `BICHO_SCANNER__*`).
 *
 * Semgrep is optional so the app runs where the binary is absent (it degrades to LLM analyzers).
 */
export const scannerSettingsSchema = z.object({
  semgrepEnabled: envBoolean.default(true),
  semgrepConfig: z.string().default("resources/semgrep"),
  semgrepTimeoutSeconds: envNumber.default(60),
  /** `npm audit` queries the registry advisory endpoint over the network; disable it when offline. */
  npmAuditEnabled: envBoolean.default(true),
  npmAuditTimeoutSeconds: envNumber.default(60),
});
export type ScannerSettings = Readonly<z.output<typeof scannerSettingsSchema>>;

/** Typed, validated application settings. */
export const settingsSchema = z.object({
  environment: z.enum(Environment).default(Environment.LOCAL),
  logLevel: logLevelSchema.default("info"),
  /** `null` => derive from the environment (JSON logs in production, human-readable elsewhere). */
  jsonLogs: envBoolean.nullable().default(null),

  github: githubSettingsSchema.prefault({}),
  llm: llmSettingsSchema.prefault({}),
  scanner: scannerSettingsSchema.prefault({}),

  /** Total wall-clock backstop for one review; it fails cleanly past this rather than hanging. */
  reviewTimeoutSeconds: envNumber.default(300),
  /**
   * When on, an extra batched model call verifies candidate findings to cut false positives (adds
   * latency; degrades to the deterministic policy if the call fails).
   */
  verifierEnabled: envBoolean.default(false),
});

export type Settings = Readonly<z.output<typeof settingsSchema>>;

/** Load and validate settings from an environment (defaults to the real process environment). */
export function loadSettings(source: NodeJS.ProcessEnv = process.env): Settings {
  return settingsSchema.parse(expandEnv(source));
}

/** Return the selected provider's spec (an empty spec if it is not configured). */
export function activeProvider(settings: Settings): ProviderSpec {
  return settings.llm.providers[settings.llm.active] ?? providerSpecSchema.parse({});
}

/** Whether logs render as JSON (production default, overridable). */
export function renderJsonLogs(settings: Settings): boolean {
  return settings.jsonLogs ?? isProduction(settings.environment);
}
