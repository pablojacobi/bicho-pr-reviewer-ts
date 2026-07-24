# ADR-0008: One review per head SHA — idempotency marker and stale-head guard

- **Status:** Accepted
- **Context:** guaranteeing at most one published review per PR head

## Context

Two different races threaten "exactly one review per commit." The first is idempotency across
runs: a webhook redelivery, a manual re-trigger, or a retried request should not produce a second
review for a head already reviewed — and per
[ADR-0003](0003-no-database-github-as-source-of-truth.md), there is no database to check that
against. The second is a race *within* one run: a review takes real wall-clock time (graph
fan-out, several model calls), and the PR's head can move — a new commit pushed — between when
analysis started and when the review is about to publish. Publishing at that point would attach
comments anchored to a diff that is no longer the one on the PR.

## Decision

Two independent guards, both evaluated late in the graph, immediately before publishing.

**Idempotency guard** (`idempotency_guard`): reads the PR's existing reviews from GitHub and
parses each body for the hidden marker (`src/domain/models/marker.ts`) — an HTML comment carrying
`head_sha`, `workflow_version`, a `run` fingerprint, `model`, and `prompt`. If any existing
review's marker matches the current head SHA *and* the current workflow version, the run stops as
`SKIPPED`. `dryRun` and `force` are the only ways past this guard, and both are explicit
`ReviewOptions`.

**Stale-head guard** (`stale_head_guard`): immediately before publishing, re-fetches the PR and
compares its head SHA against the one analysis started from. A mismatch stops the run as `STALE`
rather than publishing against a diff that has since moved.

Bumping `WORKFLOW_VERSION` (`application/graph/compose.ts`) or the prompt version
(`application/prompts/registry.ts`) changes what the marker records, so a past review's marker no
longer matches a new run — the deliberate, supported way to force every open PR to be re-reviewed
after a real change to how reviews are produced.

## Consequences

- Idempotency depends on the marker surviving in the review body; nothing outside GitHub tracks
  review history, the trade-off named plainly in
  [ADR-0003](0003-no-database-github-as-source-of-truth.md).
- The stale-head guard costs one extra GitHub API call per review but closes a real race, not a
  theoretical one — a push landing mid-analysis is ordinary, not exotic.
- `force` overrides the idempotency guard for manual re-runs and is reachable only through the
  manual endpoint, never the webhook path.
