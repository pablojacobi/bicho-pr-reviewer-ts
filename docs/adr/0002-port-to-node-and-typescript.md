# ADR-0002: Port the reviewer to Node and TypeScript

- **Status:** Accepted
- **Context:** starting the Node/TypeScript port of bicho-pr-reviewer

## Context

This repository is a from-scratch second implementation of
[bicho-pr-reviewer](https://github.com/pablojacobi/bicho-pr-reviewer), the original Python,
FastAPI and LangGraph reviewer. The Python version already works: it gathers PR context, fans out
to deterministic scanners and LLM analyzers, verifies findings, and publishes one GitHub review.
Rewriting it in Node and TypeScript is not a response to any deficiency in Python — it is a
deliberate choice to prove the architecture holds on a second stack, and to produce an idiomatic
Node service rather than a Python service wearing a Node runtime. AGENTS.md calls the
single-container, no-database shape "a deliberate cost/portfolio choice"; the same is true of the
port itself.

Two other options existed. Leave the reviewer Python-only: simpler, but then the claim that this
architecture is good design — rather than an artefact of Python's ecosystem (Pydantic, `asyncio`,
LangGraph's Python API) — stays untested. Or wrap the existing Python service behind a thin Node
facade: this multiplies the deployment surface (two runtimes, two health checks, two failure
modes) for a service whose entire design point is a single simple instance (see
[ADR-0004](0004-single-container-in-process-background-tasks.md)) — the
opposite of what a facade buys.

## Decision

Rebuild the reviewer as a new Node + TypeScript codebase on the current stack (Node 24, TypeScript
7 strict, Fastify, LangGraph.js, Zod), preserving the Python original's layering, its invariants
(100% coverage and TDD, the verifier gate, the resilient fan-out, the idempotency marker), and its
testing discipline — while re-deriving each idiom natively rather than transliterating Python line
by line. ARCHITECTURE.md's "Notable design choices in this port" catalogues where TypeScript
forced a genuinely different answer: state channels, frozen models, resource cleanup, structured
output, symbol resolution. The port also moved *what* the reviewer analyzes, from Python to
TypeScript/JavaScript — see [ADR-0010](0010-typescript-as-the-primary-analysis-target.md).

## Consequences

- What it buys: proof the architecture is not a Python artefact, and a Node service that reviews
  Node code instead of a Node service whose only competence is a different ecosystem.
- What it costs: two codebases now carry the same architecture, with no mechanism keeping them in
  step. A fix or a prompt improvement discovered in one does not propagate to the other; someone
  has to notice and port it by hand, in both directions, indefinitely.
- Two dependency ecosystems to keep patched, two CI pipelines, two Dockerfiles.
- The `BICHO_` environment contract is kept identical on purpose, so one deployment environment
  configures either implementation without translation.
