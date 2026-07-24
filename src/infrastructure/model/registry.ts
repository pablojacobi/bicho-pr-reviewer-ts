/**
 * Builds the concrete chat model and provider from configuration.
 *
 * Every supported model is reached through an OpenAI-compatible endpoint, so `ChatOpenAI` is the
 * transport: the model id and base URL are configuration, never hard-coded, and nothing here is
 * vendor-specific in code. `temperature: 0` and `maxRetries: 0` keep runs deterministic and bound
 * latency; retries and fallback are handled explicitly by the provider, not silently by the client.
 */

import { ChatOpenAI } from "@langchain/openai";
import { LangChainModelProvider } from "./provider.ts";

/** Everything needed to construct a chat model and its provider wrapper. */
export interface ModelSpec {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutSeconds: number;
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
  readonly maxConcurrency: number;
}

/**
 * Construct a `ChatOpenAI` pointed at an OpenAI-compatible endpoint.
 *
 * `maxRetries` and `timeout` go inside `configuration`, which is what reaches the underlying
 * OpenAI SDK client. Passing them as top-level `ChatOpenAI` options looks right but is silently
 * dropped, leaving the SDK on its default of two internal retries — those would compound with the
 * provider's own explicit retry policy and quietly multiply the request count.
 */
export function buildChatModel(spec: ModelSpec): ChatOpenAI {
  return new ChatOpenAI({
    model: spec.model,
    apiKey: spec.apiKey,
    configuration: {
      baseURL: spec.baseUrl,
      timeout: spec.timeoutSeconds * 1000,
      maxRetries: 0,
    },
    temperature: 0,
  });
}

/** Construct the structured-output provider used by every analyzer and the verifier. */
export function buildModelProvider(spec: ModelSpec): LangChainModelProvider {
  return new LangChainModelProvider({
    model: buildChatModel(spec),
    modelId: spec.model,
    maxAttempts: spec.maxAttempts,
    retryDelaySeconds: spec.retryDelaySeconds,
    maxConcurrency: spec.maxConcurrency,
  });
}
