/**
 * A {@link ModelProvider} backed by a LangChain chat model.
 *
 * Structured output is obtained via **function/tool calling** (not JSON mode): OpenAI-compatible
 * third-party endpoints such as MiniMax's do not reliably honour `response_format`. The model is
 * bound to the target schema as a tool and `includeRaw: true` returns both the raw message and the
 * parsed value, so an invalid tool call surfaces as a parsing error returned as *data* rather than
 * thrown.
 *
 * The concrete chat model is injected, keeping this class free of any provider-specific import;
 * `registry.ts` builds it from settings.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { z } from "zod";
import {
  errorResult,
  type ModelProvider,
  type ModelResult,
  okResult,
  type RunMeta,
} from "../../domain/ports/modelProvider.ts";
import { Semaphore } from "./semaphore.ts";

/** The shape `withStructuredOutput(..., { includeRaw: true })` resolves to. */
interface RawStructuredOutput {
  raw?: unknown;
  parsed?: unknown;
  parsingError?: unknown;
}

/** Runs a structured, schema-validated model call through an injected LangChain chat model. */
export class LangChainModelProvider implements ModelProvider {
  readonly #model: BaseChatModel;
  readonly #modelId: string;
  readonly #maxAttempts: number;
  readonly #retryDelaySeconds: number;
  /**
   * A shared semaphore bounds calls to this provider across the whole review; `null` means
   * unbounded. One instance is shared by every analyzer, so a limit of 1 runs the LLM analyzers
   * serially while the deterministic scanners still fan out.
   */
  readonly #semaphore: Semaphore | null;
  readonly #sleep: (seconds: number) => Promise<void>;

  constructor(options: {
    model: BaseChatModel;
    modelId: string;
    maxAttempts?: number;
    retryDelaySeconds?: number;
    maxConcurrency?: number;
    /** Injectable so retry tests do not spend real wall-clock time. */
    sleep?: (seconds: number) => Promise<void>;
  }) {
    this.#model = options.model;
    this.#modelId = options.modelId;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.#retryDelaySeconds = options.retryDelaySeconds ?? 0;
    const maxConcurrency = options.maxConcurrency ?? 0;
    this.#semaphore = maxConcurrency > 0 ? new Semaphore(maxConcurrency) : null;
    this.#sleep =
      options.sleep ?? ((seconds) => new Promise((done) => setTimeout(done, seconds * 1000)));
  }

  async structured<T>(request: {
    prompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
    meta: RunMeta;
  }): Promise<ModelResult<T>> {
    if (this.#semaphore === null) {
      return this.#withRetries(request);
    }
    return this.#semaphore.run(() => this.#withRetries(request));
  }

  async #withRetries<T>(request: {
    prompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
    meta: RunMeta;
  }): Promise<ModelResult<T>> {
    let result = await this.#attempt(request);
    let attempt = 1;
    while (!result.ok && attempt < this.#maxAttempts) {
      await this.#sleep(this.#retryDelaySeconds);
      result = await this.#attempt(request);
      attempt += 1;
    }
    return result;
  }

  async #attempt<T>(request: {
    prompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
    meta: RunMeta;
  }): Promise<ModelResult<T>> {
    let response: unknown;
    try {
      const structuredModel = this.#model.withStructuredOutput(request.schema, {
        name: request.schemaName,
        method: "functionCalling",
        includeRaw: true,
      });
      response = await structuredModel.invoke(request.prompt, runConfig(request.meta));
    } catch (error) {
      // Transport and timeout failures are returned as data, never thrown: a raised exception in a
      // parallel graph branch would roll back the whole superstep.
      return errorResult(describeError(error), this.#modelId);
    }

    const { raw, parsed, parsingError } = (response ?? {}) as RawStructuredOutput;
    const rawText = messageText(raw);
    if (parsed === null || parsed === undefined) {
      const reason =
        parsingError === undefined || parsingError === null
          ? "model returned no structured output"
          : describeError(parsingError);
      return errorResult(reason, this.#modelId, rawText);
    }
    return okResult(parsed as T, this.#modelId, rawText);
  }
}

/** Attach role/prompt/correlation tags so LangSmith records each call in context. */
function runConfig(meta: RunMeta): RunnableConfig {
  return {
    runName: meta.role,
    tags: [...meta.tags, `role:${meta.role}`, `prompt:${meta.promptVersion}`],
    metadata: { correlationId: meta.correlationId, promptVersion: meta.promptVersion },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Best-effort textual content of the raw message, for tracing and the technical summary. */
function messageText(message: unknown): string | null {
  if (typeof message === "object" && message !== null && "content" in message) {
    return String((message as { content: unknown }).content);
  }
  return null;
}
