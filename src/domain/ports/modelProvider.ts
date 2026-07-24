/**
 * Port for structured LLM calls.
 *
 * The domain and application layers reach models only through this port, so they never import
 * provider-specific classes. A call returns a {@link ModelResult} — a parse failure or transport
 * error is returned as data, not thrown — which the resilient graph nodes turn into a degraded
 * outcome.
 */

import type { z } from "zod";

/** Metadata attached to a model call for tracing (LangSmith) and the technical summary. */
export interface RunMeta {
  readonly role: string;
  readonly promptVersion: string;
  readonly correlationId: string;
  readonly tags: readonly string[];
}

/** Build a {@link RunMeta}, defaulting the tag list to empty. */
export function makeRunMeta(meta: {
  role: string;
  promptVersion: string;
  correlationId: string;
  tags?: readonly string[];
}): RunMeta {
  return { ...meta, tags: meta.tags ?? [] };
}

/** The outcome of a structured model call: a validated value, or an error (never thrown). */
export type ModelResult<T> =
  | { readonly ok: true; readonly modelId: string; readonly value: T; readonly raw: string | null }
  | {
      readonly ok: false;
      readonly modelId: string;
      readonly error: string;
      readonly raw: string | null;
    };

/** Build a successful, validated model result. */
export function okResult<T>(value: T, modelId: string, raw: string | null = null): ModelResult<T> {
  return { ok: true, modelId, value, raw };
}

/** Build a failed model result (transport error, or invalid/unparseable output). */
export function errorResult<T>(
  error: string,
  modelId: string,
  raw: string | null = null,
): ModelResult<T> {
  return { ok: false, modelId, error, raw };
}

/** Executes a structured, schema-validated model call. */
export interface ModelProvider {
  structured<T>(request: {
    prompt: string;
    schema: z.ZodType<T>;
    /** The name the schema is bound under as a tool; part of the function-calling contract. */
    schemaName: string;
    meta: RunMeta;
  }): Promise<ModelResult<T>>;
}
