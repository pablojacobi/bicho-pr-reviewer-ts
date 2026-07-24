# Limitations

Bicho runs as "a single container, single instance, with no database" by deliberate choice
(AGENTS.md calls it "a deliberate cost/portfolio choice"). Every constraint below follows from
that choice or from a related one recorded in [docs/adr/](adr/). They are documented here plainly,
each as a trade-off that was accepted on purpose, with the condition under which it would be
revisited — not as a defect list.

## Background tasks are in-process and non-durable

A webhook-triggered review runs as an in-process background task after the request already
returned `202` (`src/api/background.ts`). Nothing survives a process restart except what already
reached GitHub: a review that was accepted but not yet published is simply gone, with no record it
was ever accepted and no automatic retry.

This is the direct cost of [ADR-0004](adr/0004-single-container-in-process-background-tasks.md)'s
decision not to run a queue and a worker. It is recoverable, not silent: the manual endpoint
(`POST /reviews`) re-runs the identical graph on demand, and a later event for the same PR (a new
push, or GitHub's own redelivery) triggers a fresh attempt regardless.

Revisit when: review volume or acceptable staleness makes "wait for the next event" an
unacceptable recovery path. At that point the fix is a durable queue, which reopens
[ADR-0004](adr/0004-single-container-in-process-background-tasks.md), not a bigger in-memory
semaphore.

## One instance, one review at a time

`BackgroundReviewRunner` bounds concurrency with a semaphore that defaults to 1
(`src/infrastructure/model/semaphore.ts`), matching the single-container deployment
([ADR-0004](adr/0004-single-container-in-process-background-tasks.md)). A second review that
arrives while one is running waits in memory; it is not dropped, but it is not concurrent either.

Throughput is therefore one review's wall-clock time — typically dominated by several model calls
plus two scanners — per unit of review volume, and there is no horizontal scaling story: running
two containers would risk double-publishing, since idempotency is coordinated only by re-reading
GitHub, never by a cross-instance lock.

Revisit when: webhook volume regularly queues behind the semaphore long enough to risk GitHub's
own delivery timeout. At that point either the semaphore rises on one instance, or the deployment
model changes — which reopens
[ADR-0004](adr/0004-single-container-in-process-background-tasks.md).

## No exactly-once webhook delivery

GitHub redelivers webhooks on timeout or transient failure, and duplicate deliveries are expected,
not exceptional. `RecentDeliveries` (`src/api/background.ts`) de-duplicates delivery ids in a
bounded, in-memory set — there is no datastore behind it, matching
[ADR-0003](adr/0003-no-database-github-as-source-of-truth.md). A process restart clears that set,
so a redelivery landing right after a restart is treated as new, and a review is scheduled again
for a PR that may already have one in flight or published.

The real backstop is not delivery de-duplication — it is the marker-based idempotency guard
([ADR-0008](adr/0008-one-review-idempotency-marker-and-stale-head-guard.md)), which checks GitHub
itself rather than process memory and survives a restart. `RecentDeliveries` is a fast-path
optimisation to skip obviously-redundant work before the graph even starts; it is not the
correctness mechanism, and nothing here depends on it being perfect.

Revisit when: reading every existing review on a PR to evaluate the idempotency guard becomes
measurably slow on PRs with a long review history — that is a reason to cache, not a reason this
limitation changes.

## No database — no history or analytics

Per [ADR-0003](adr/0003-no-database-github-as-source-of-truth.md), Bicho keeps no record of what
it has reviewed beyond what is visible on GitHub itself. There is no query for trend data —
findings per category over time, which analyzer is noisiest, false-positive rate by repository —
because nowhere accumulates that data.

Revisit when: a concrete reporting need appears that re-reading GitHub's own review history cannot
answer. At that point the honest fix is a small, explicitly-scoped analytics store, not smuggling
extra state into the marker.

## LLM analyzers are non-deterministic and cost money

Six of the eight fan-out nodes are model calls. `temperature: 0`
(`src/infrastructure/model/registry.ts`) narrows variance but does not eliminate it, and re-running
the same PR can produce a differently-worded, or occasionally differently-scoped, finding. Every
one of those calls is billed by the configured provider — a review has a real, non-zero marginal
cost, unlike a purely static-analysis reviewer.

Revisit when: cost or variance for a given repository outweighs the value of contextual review.
`defaultAnalyzers()` per language adapter and the `BICHO_SCANNER__*` flags already let an operator
narrow which analyzers run without a code change.

## `npm audit` needs the network

`npm audit` queries the npm registry's advisory endpoint; it cannot run offline.
`BICHO_SCANNER__NPM_AUDIT_ENABLED=false` disables it cleanly for an offline or
network-restricted deployment, and its absence degrades a review (one fewer scanner) rather than
failing it.

Revisit when: an offline-capable advisory source (a mirrored vulnerability database) becomes worth
the added operational surface for a deployment that genuinely cannot reach the network.

## Semgrep: Community Edition, a small curated ruleset

Semgrep CE, not Pro, and rules are hand-picked in `resources/semgrep/`, not pulled from the
community registry — `--config=auto` is refused outright because it reaches the network (see
[ADR-0009](adr/0009-deterministic-scanners.md)). Real vulnerability patterns outside the curated
set go undetected by Semgrep specifically; they remain in scope for the LLM security analyzer,
which has no fixed ruleset to exhaust.

Revisit when: a specific missed pattern class is worth committing a new rule for. The ruleset is
meant to grow by deliberate addition, not by pointing at someone else's registry.

## Review quality depends on the diff being self-contained

The reviewer sees the PR diff and the head content of the changed, in-scope files
(`gather_file_contents` in `src/application/graph/nodes.ts`) — not the rest of the repository.
Enclosing-symbol resolution, dependency scanning, and every analyzer prompt work from that same
limited view. A bug whose cause lives entirely outside the diff — a caller three files away that
now violates a changed contract — is outside what any analyzer can see.

Revisit when: a class of finding is consistently missed for want of repository-wide context. The
fix (fetching related files beyond the diff) has to be weighed against the security posture in
AGENTS.md of never cloning or executing the wider repository, not adopted by default.
