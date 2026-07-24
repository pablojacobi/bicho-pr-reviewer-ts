# ADR-0004: Single container, in-process background tasks

- **Status:** Accepted
- **Context:** deciding the deployment topology and how webhook work runs

## Context

A GitHub webhook must be acknowledged quickly — GitHub retries and can eventually disable a hook
that times out — but the review it triggers (fetch the PR, run eight scanners and analyzers,
verify, publish) routinely takes longer than a request should make GitHub wait. Something has to
run that work after the response is sent, and something has to decide how many reviews run at
once.

The conventional answer is a queue and a worker pool: push a job (Celery, BullMQ, SQS) on webhook
receipt and let one or more workers drain it durably, surviving a restart. That is the right answer
once reviews arrive faster than one instance can process them, or once losing an in-flight job is
unacceptable. It also means a second deployable, a broker, and a second dependency that can be
down.

## Decision

One container, one instance, no queue. The webhook handler verifies the signature, filters the
event, and calls `BackgroundReviewRunner.schedule` (`src/api/background.ts`), which runs the
review as an in-process background task and returns `202` immediately. A `Semaphore` (default 1,
matching the single instance) bounds how many reviews run concurrently, so load beyond that queues
in memory instead of overrunning the model provider or GitHub's API.

This is explicitly **non-durable**: nothing survives a restart except what already reached GitHub.
`RecentDeliveries`, in the same file, short-circuits duplicate webhook deliveries in memory, with
no datastore behind it either — see [ADR-0003](0003-no-database-github-as-source-of-truth.md).

## Consequences

- A restart drops an accepted-but-unfinished review with no automatic retry. This is documented,
  not hidden — see [docs/limitations.md](../limitations.md) — and recoverable through the manual
  `POST /reviews` endpoint, which re-runs the identical graph on demand.
- Throughput is bounded by one instance running the semaphore's permit count of reviews at a time;
  scaling out would mean revisiting this ADR, since two instances would coordinate idempotency
  through nothing more than re-reading GitHub.
- The manual and webhook paths schedule the exact same `ReviewService.run`, so there is one code
  path to reason about, never two that can drift apart.
- No broker, no second outage source, no operational surface beyond the one process.
