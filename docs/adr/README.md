# Architecture Decision Records

Short, immutable records of the significant decisions behind this repository — see
[ADR-0001](0001-use-architecture-decision-records.md) for why they exist and how they are
written. Each follows the same shape (`Context` / `Decision` / `Consequences`); none are rewritten
after acceptance — a changed decision gets a new ADR, not an edit to an old one.

| ADR | Summary |
| --- | --- |
| [0001 — Use Architecture Decision Records](0001-use-architecture-decision-records.md) | Why decisions are recorded as short, immutable documents in the repo. |
| [0002 — Port the reviewer to Node and TypeScript](0002-port-to-node-and-typescript.md) | Why this is a full second implementation of the Python original, not a wrapper around it. |
| [0003 — No database — GitHub as the source of truth](0003-no-database-github-as-source-of-truth.md) | No datastore; idempotency is read back from GitHub itself. |
| [0004 — Single container, in-process background tasks](0004-single-container-in-process-background-tasks.md) | One instance, no queue; webhook work runs in-process and is explicitly non-durable. |
| [0005 — 100% line and branch coverage, and TDD](0005-one-hundred-percent-coverage-and-tdd.md) | The coverage gate as a forcing function, not a claim of correctness. |
| [0006 — Language-agnostic core with adapters](0006-language-agnostic-core-with-adapters.md) | The `LanguageAdapter` port that keeps `domain/` and `application/` free of any one language. |
| [0007 — Model-provider abstraction and function calling](0007-model-provider-abstraction-and-function-calling.md) | Models reached only through `ModelProvider`; structured output via function calling, not JSON mode. |
| [0008 — One review per head SHA — idempotency marker and stale-head guard](0008-one-review-idempotency-marker-and-stale-head-guard.md) | The two guards that keep exactly one published review per commit. |
| [0009 — Deterministic scanners](0009-deterministic-scanners.md) | Pairing Semgrep CE and `npm audit` with the LLM analyzers, both gated by the same verifier. |
| [0010 — TypeScript/JavaScript as the primary analysis target](0010-typescript-as-the-primary-analysis-target.md) | Why the port also moved what the reviewer analyzes, from Python to TypeScript/JavaScript. |
| [0011 — `oxc-parser` for enclosing-symbol resolution](0011-oxc-parser-for-symbol-resolution.md) | Why symbol resolution uses `oxc-parser` rather than the TypeScript compiler's own (unstable) parser API. |
