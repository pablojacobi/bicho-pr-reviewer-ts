# ADR-0003: No database — GitHub as the source of truth

- **Status:** Accepted
- **Context:** deciding what backs idempotency and review history

## Context

Bicho must not publish the same review twice for one commit, and on the manual endpoint it must
decide, per request, whether a given head SHA was already reviewed. That requires remembering,
somewhere, what already happened. The obvious place is a datastore: a small Postgres table keyed
on `(repository, pr_number, head_sha)`, or a Redis set for a cheaper, less durable version of the
same idea.

Either gives correct idempotency plus something extra: a query surface. "How many CRITICAL
findings did we publish last month" becomes a `SELECT`. But both also give the service state to
operate: a schema to migrate, a connection to keep alive, a backup policy, and a second dependency
that can be down when GitHub is up. For a single-instance, no-fleet service (see
[ADR-0004](0004-single-container-in-process-background-tasks.md)), that is a lot of operational
surface for a fact GitHub already records: whether a review exists on the PR.

## Decision

No database. GitHub itself is the source of truth for what has already been reviewed. Bicho embeds
one hidden HTML comment — the marker, `src/domain/models/marker.ts` — in every review it
publishes, carrying the head SHA, the workflow version, a run fingerprint, the model id, and the
prompt version. Before publishing again, `idempotency_guard` reads the PR's existing reviews back
through the GitHub API and looks for a marker whose head SHA and workflow version match the
current run. No matching marker means proceed.

## Consequences

- Zero operational surface: no schema, no migration, no connection pool, no second outage source
  to monitor.
- No cross-run analytics. There is no query for "findings over time across every installation" —
  the only record is the reviews themselves, readable one PR at a time through the GitHub API.
- Idempotency is only as good as the marker. It survives ordinary edits to a review body that
  leave the trailing comment intact, and it is scoped to Bicho's own reviews because only Bicho
  writes that exact comment syntax — but this is a convention the marker parser recognizes, not a
  constraint GitHub enforces, so a review body stripped of trailing HTML comments would defeat it.
- Deliberately forcing a re-review (a prompt or workflow change) is done by bumping the marker's
  version fields, not by deleting state that does not exist — see
  [ADR-0008](0008-one-review-idempotency-marker-and-stale-head-guard.md).
