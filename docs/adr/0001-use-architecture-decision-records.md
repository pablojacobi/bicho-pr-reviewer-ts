# ADR-0001: Use Architecture Decision Records

- **Status:** Accepted
- **Context:** establishing how architectural decisions get recorded in this repository

## Context

This project accumulates decisions that are not obvious from reading the code: why there is no
database, why it runs as one instance instead of a fleet, why coverage is gated at 100%, why
structured model output goes through function calling instead of JSON mode. Each is a real
trade-off chosen over a plausible-looking alternative, for reasons that matter as much as the
choice itself. Left unwritten, that reasoning gets re-litigated: a future contributor — human or,
per AGENTS.md, an AI agent working from this repository — proposes the rejected alternative again,
or "fixes" a deliberate constraint without knowing it was deliberate.

Three places could hold this reasoning. A wiki lives outside the repository, drifts out of sync
with the code it describes, and is not reviewed alongside the change that motivated it. Commit
messages carry rationale at the moment of the change, but are not indexed by topic and do not get
revised as understanding of a trade-off improves later. Tribal knowledge means every debate is
re-run from scratch, and onboarding depends on asking the right person the right question.

## Decision

Record every significant architectural decision as a short Markdown document under `docs/adr/`,
numbered sequentially (`NNNN-kebab-case-title.md`), in one fixed shape: a status line, a one-line
context, then `Context`, `Decision`, `Consequences`. An ADR is immutable once accepted — a change
of direction is a new ADR, not a rewrite of an old one, so the record of *why* a past choice was
made stays intact even after the choice itself is revisited. AGENTS.md's documentation rules make
this a requirement, not a suggestion: every significant decision gets an ADR, updated in the same
PR as the change it documents.

## Consequences

- Every non-obvious constraint in this repository — no database, single instance, 100% coverage,
  the model-provider abstraction, and so on — has a citable reason, not just a citable outcome.
- `docs/adr/README.md` indexes every ADR, so "why is it built this way" has one starting point
  instead of an archaeology exercise through commit history.
- Recording a decision costs one small file, not a meeting, which keeps the practice from being
  skipped under deadline pressure.
- A rejected alternative is written down alongside the choice, so it does not get silently
  re-proposed by someone who was not in the room the first time.
