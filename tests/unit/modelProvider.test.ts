import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, it } from "vitest";
import { analyzerReportSchema } from "../../src/application/analyzers/schemas.ts";
import { makeRunMeta } from "../../src/domain/ports/modelProvider.ts";
import { FakeModelProvider } from "../../src/infrastructure/model/fake.ts";
import { LangChainModelProvider } from "../../src/infrastructure/model/provider.ts";
import { buildChatModel, buildModelProvider } from "../../src/infrastructure/model/registry.ts";

interface StubCall {
  readonly prompt: unknown;
  readonly config: unknown;
  readonly options: unknown;
}

/**
 * A stand-in for a LangChain chat model.
 *
 * Faking at `withStructuredOutput` — the public interface the provider actually depends on — rather
 * than at the HTTP layer keeps these tests about the provider's own behaviour: retries, the
 * semaphore, and turning failures into data.
 */
function stubModel(responses: readonly (unknown | Error)[]) {
  const calls: StubCall[] = [];
  const queue = [...responses];
  const model = {
    withStructuredOutput(_schema: unknown, options: unknown) {
      return {
        invoke: async (prompt: unknown, config: unknown) => {
          calls.push({ prompt, config, options });
          const next = queue.length > 1 ? queue.shift() : queue[0];
          if (next instanceof Error) {
            throw next;
          }
          return next;
        },
      };
    },
  } as unknown as BaseChatModel;
  return { model, calls };
}

const meta = makeRunMeta({
  role: "security",
  promptVersion: "v1",
  correlationId: "corr-1",
  tags: ["extra"],
});

function aProvider(model: BaseChatModel, overrides: Record<string, unknown> = {}) {
  return new LangChainModelProvider({
    model,
    modelId: "test-model",
    sleep: async () => {},
    ...overrides,
  });
}

function call(provider: LangChainModelProvider) {
  return provider.structured({
    prompt: "analyze this",
    schema: analyzerReportSchema,
    schemaName: "report_findings",
    meta,
  });
}

describe("LangChainModelProvider", () => {
  it("returns the parsed value on success", async () => {
    const parsed = { findings: [] };
    const { model } = stubModel([{ raw: { content: "raw text" }, parsed }]);

    const result = await call(aProvider(model));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(parsed);
    expect(result.modelId).toBe("test-model");
    expect(result.raw).toBe("raw text");
  });

  it("binds the schema as a tool via function calling, with the requested name", async () => {
    const { model, calls } = stubModel([{ parsed: { findings: [] } }]);

    await call(aProvider(model));

    expect(calls[0]?.options).toEqual({
      name: "report_findings",
      method: "functionCalling",
      includeRaw: true,
    });
  });

  it("tags the run with the role and prompt version for tracing", async () => {
    const { model, calls } = stubModel([{ parsed: { findings: [] } }]);

    await call(aProvider(model));

    expect(calls[0]?.config).toMatchObject({
      runName: "security",
      tags: ["extra", "role:security", "prompt:v1"],
      metadata: { correlationId: "corr-1", promptVersion: "v1" },
    });
  });

  it("returns a transport failure as data instead of throwing", async () => {
    const { model } = stubModel([new Error("connection reset")]);

    const result = await call(aProvider(model));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Error: connection reset");
  });

  it("describes a thrown non-Error value", async () => {
    const { model } = stubModel([]);
    const throwing = {
      withStructuredOutput: () => ({
        invoke: async () => {
          throw "plain string failure";
        },
      }),
    } as unknown as BaseChatModel;
    void model;

    const result = await call(aProvider(throwing));

    expect(result.ok === false && result.error).toBe("plain string failure");
  });

  it("reports a missing structured output as an error, keeping the raw text", async () => {
    const { model } = stubModel([{ raw: { content: "not a tool call" }, parsed: null }]);

    const result = await call(aProvider(model));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("model returned no structured output");
    expect(result.raw).toBe("not a tool call");
  });

  it("surfaces the parsing error when the model emitted an invalid tool call", async () => {
    const { model } = stubModel([
      { raw: { content: "{}" }, parsed: undefined, parsingError: new Error("missing field") },
    ]);

    const result = await call(aProvider(model));

    expect(result.ok === false && result.error).toBe("Error: missing field");
  });

  it("reports no raw text when the response carries no message", async () => {
    const { model } = stubModel([{ parsed: { findings: [] } }]);

    const result = await call(aProvider(model));

    expect(result.raw).toBeNull();
  });

  it("tolerates a response that is not an object at all", async () => {
    const { model } = stubModel([undefined]);

    const result = await call(aProvider(model));

    expect(result.ok).toBe(false);
  });

  it("retries a failed call up to maxAttempts and succeeds on a later attempt", async () => {
    const { model, calls } = stubModel([
      new Error("503"),
      new Error("503"),
      { parsed: { findings: [] } },
    ]);

    const result = await call(aProvider(model, { maxAttempts: 3, retryDelaySeconds: 0 }));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxAttempts and returns the last failure", async () => {
    const { model, calls } = stubModel([new Error("still 503")]);

    const result = await call(aProvider(model, { maxAttempts: 2 }));

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a successful call", async () => {
    const { model, calls } = stubModel([{ parsed: { findings: [] } }]);

    await call(aProvider(model, { maxAttempts: 5 }));

    expect(calls).toHaveLength(1);
  });

  it("waits the configured delay between attempts", async () => {
    const delays: number[] = [];
    const { model } = stubModel([new Error("503")]);
    const provider = new LangChainModelProvider({
      model,
      modelId: "test-model",
      maxAttempts: 3,
      retryDelaySeconds: 2,
      sleep: async (seconds) => {
        delays.push(seconds);
      },
    });

    await call(provider);

    expect(delays).toEqual([2, 2]);
  });

  it("treats maxAttempts below one as a single attempt", async () => {
    const { model, calls } = stubModel([new Error("503")]);

    await call(aProvider(model, { maxAttempts: 0 }));

    expect(calls).toHaveLength(1);
  });

  it("runs calls unbounded when no concurrency limit is set", async () => {
    const { model } = stubModel([{ parsed: { findings: [] } }]);
    const provider = aProvider(model, { maxConcurrency: 0 });

    const results = await Promise.all([call(provider), call(provider)]);

    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("serializes calls through the semaphore when concurrency is limited to one", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let seen = 0;
    const model = {
      withStructuredOutput: () => ({
        invoke: async () => {
          seen += 1;
          const label = `call-${seen}`;
          order.push(`${label}:start`);
          if (label === "call-1") {
            await new Promise<void>((resolvePermit) => {
              releaseFirst = resolvePermit;
            });
          }
          order.push(`${label}:end`);
          return { parsed: { findings: [] } };
        },
      }),
    } as unknown as BaseChatModel;
    const provider = aProvider(model, { maxConcurrency: 1 });

    const first = call(provider);
    const second = call(provider);
    await Promise.resolve();
    expect(order).toEqual(["call-1:start"]);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["call-1:start", "call-1:end", "call-2:start", "call-2:end"]);
  });

  it("falls back to a real timer between retries when no sleep is injected", async () => {
    let attempts = 0;
    const model = {
      withStructuredOutput: () => ({
        invoke: async () => {
          attempts += 1;
          throw new Error("503");
        },
      }),
    } as unknown as BaseChatModel;
    const provider = new LangChainModelProvider({
      model,
      modelId: "test-model",
      maxAttempts: 2,
      retryDelaySeconds: 0,
    });

    const result = await provider.structured({
      prompt: "p",
      schema: analyzerReportSchema,
      schemaName: "report_findings",
      meta: makeRunMeta({ role: "security", promptVersion: "v1", correlationId: "c" }),
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
  });
});

describe("model registry", () => {
  const spec = {
    model: "minimax-m3",
    apiKey: "test-key",
    baseUrl: "https://api.minimax.io/v1",
    timeoutSeconds: 30,
    maxAttempts: 2,
    retryDelaySeconds: 1,
    maxConcurrency: 1,
  };

  it("points the chat model at the configured OpenAI-compatible endpoint", () => {
    const model = buildChatModel(spec);

    expect(model.model).toBe("minimax-m3");
    expect(model.temperature).toBe(0);
    expect(model.clientConfig).toMatchObject({ baseURL: "https://api.minimax.io/v1" });
  });

  it("disables the SDK's own retries so only the explicit policy retries", () => {
    // Passed as a top-level ChatOpenAI option these are silently dropped, leaving the OpenAI SDK on
    // its default of two internal retries — which would compound with the provider's retry loop.
    expect(buildChatModel(spec).clientConfig).toMatchObject({ maxRetries: 0, timeout: 30_000 });
  });

  it("builds a provider around the configured chat model", () => {
    expect(buildModelProvider(spec)).toBeInstanceOf(LangChainModelProvider);
  });
});

describe("FakeModelProvider", () => {
  it("reports a missing script rather than hanging or throwing", async () => {
    const result = await new FakeModelProvider().structured({
      prompt: "p",
      schema: analyzerReportSchema,
      schemaName: "report_findings",
      meta: makeRunMeta({ role: "security", promptVersion: "v1", correlationId: "c" }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("no scripted response");
    expect(result.modelId).toBe("fake-model");
  });

  it("records what it was asked", async () => {
    const provider = new FakeModelProvider();

    await provider.structured({
      prompt: "the prompt",
      schema: analyzerReportSchema,
      schemaName: "report_findings",
      meta: makeRunMeta({ role: "tests", promptVersion: "v1", correlationId: "c-9" }),
    });

    expect(provider.calls[0]).toMatchObject({
      prompt: "the prompt",
      schemaName: "report_findings",
    });
    expect(provider.calls[0]?.meta.role).toBe("tests");
  });
});
