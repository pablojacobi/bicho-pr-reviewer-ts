/**
 * A deterministic {@link ModelProvider} fake for tests and offline runs.
 *
 * It returns pre-scripted results in order and records each call, so tests can drive success,
 * invalid output, and error paths without any network or credentials.
 */

import type { z } from "zod";
import {
  errorResult,
  type ModelProvider,
  type ModelResult,
  type RunMeta,
} from "../../domain/ports/modelProvider.ts";

/** One recorded call, so tests can assert what the analyzers actually asked the model. */
export interface RecordedCall {
  readonly prompt: string;
  readonly schemaName: string;
  readonly meta: RunMeta;
}

/** Returns pre-scripted {@link ModelResult}s in order and records each call. */
export class FakeModelProvider implements ModelProvider {
  readonly calls: RecordedCall[] = [];
  readonly #results: ModelResult<unknown>[];
  readonly #modelId: string;

  constructor(results: readonly ModelResult<unknown>[] = [], modelId = "fake-model") {
    this.#results = [...results];
    this.#modelId = modelId;
  }

  async structured<T>(request: {
    prompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
    meta: RunMeta;
  }): Promise<ModelResult<T>> {
    this.calls.push({
      prompt: request.prompt,
      schemaName: request.schemaName,
      meta: request.meta,
    });
    const next = this.#results.shift();
    if (next === undefined) {
      return errorResult("no scripted response", this.#modelId);
    }
    return next as ModelResult<T>;
  }
}
