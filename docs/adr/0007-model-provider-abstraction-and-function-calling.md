# ADR-0007: Model-provider abstraction and function calling

- **Status:** Accepted
- **Context:** reaching LLMs for structured findings without coupling the core to a vendor

## Context

Six analyzers and the optional verifier all need the same thing from a model: send a prompt, get
back data matching a schema, and never let a malformed or failed response take the process down.
Two separate problems sit inside that. Which vendor: MiniMax today, per `.env.example`, but the
configuration already anticipates Gemini, OpenAI, or a local proxy, and hard-wiring analyzer code
to one SDK would mean touching six call sites plus the verifier every time that changes. And how to
get structured output at all: the obvious approach — ask for JSON, set
`response_format: json_object` — assumes the endpoint honours that field. Third-party
OpenAI-compatible endpoints do not reliably do so; MiniMax's does not. A schema built on
`response_format` would silently degrade on exactly the providers this project needs to support.

## Decision

The domain and application layers reach every model through one port,
`ModelProvider.structured()` (`src/domain/ports/modelProvider.ts`); nothing above
`infrastructure/model/` imports LangChain or a vendor SDK. `LangChainModelProvider` implements it
over `ChatOpenAI`, since every configured provider is OpenAI-compatible by construction. Structured
output uses **function calling**
(`withStructuredOutput(schema, { method: "functionCalling", includeRaw: true })`), not JSON mode:
the schema is bound as a callable tool, which every provider tested handles consistently
regardless of `response_format` support.

Every call returns a `ModelResult<T>` — `{ ok: true, value }` or `{ ok: false, error }` — never a
thrown exception. A transport failure, a timeout, or a tool call that fails to parse against the
schema all become `ok: false`, because a throw inside a parallel graph superstep rolls the whole
superstep back ([ADR-0009](0009-deterministic-scanners.md) covers the same constraint from the
scanner side). Several providers can be configured at once, each under its own name
(`BICHO_LLM__PROVIDERS__<NAME>__*`), with `BICHO_LLM__ACTIVE` selecting one — adding a model is a
new block plus flipping `ACTIVE`, never swapping keys in place.

## Consequences

- Analyzer code is identical across all six roles; only the prompt and the target category differ
  (`application/analyzers/registry.ts`).
- A provider outage or a malformed response degrades one analyzer's outcome to `ERROR`, never the
  whole review.
- Retry count, retry delay, and per-provider concurrency are configuration, not vendor-specific
  code paths (`maxAttempts`, `retryDelaySeconds`, `maxConcurrency` in `providerSpecSchema`).
