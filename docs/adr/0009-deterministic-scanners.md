# ADR-0009: Deterministic scanners

- **Status:** Accepted
- **Context:** combining deterministic scanners with LLM analyzers

## Context

LLM analyzers are good at contextual judgement — does this change violate an invariant the
surrounding code relies on — and a poor fit for a check that has one right answer and needs no
judgement at all: is this dependency version in the public advisory database. Relying on an LLM
alone for the latter is slower, costs money per check, and can miss or hallucinate a CVE that a
purpose-built tool would get right deterministically. The reverse holds too: a rules engine has no
way to judge whether a change *matters* in context.

## Decision

Run both, in the same fan-out as the six LLM analyzers, and gate everything — deterministic or
not — through the same verifier before anything publishes. **Semgrep Community Edition**, with a
curated ruleset committed under `resources/semgrep/` rather than pulled from the community
registry, covers pattern-based issues such as injection shapes. **`npm audit`**, run over changed
`package-lock.json` manifests, covers known-vulnerable dependencies — the direct analogue of the
Python original's `pip-audit` (see [ADR-0010](0010-typescript-as-the-primary-analysis-target.md)).

Semgrep never runs with `--config=auto`: that flag reaches Semgrep's registry over the network,
which this project is not willing to risk for a scanner running against untrusted repository
content. It runs offline (`--metrics=off --disable-version-check`) under the same hard, no-shell
subprocess timeout as every other subprocess. `npm audit` does need the network — it queries the
registry's advisory endpoint — so it is the one scanner that is explicitly optional and disabled
outright for an offline deployment.

Every scanner outcome is one of zero-findings, error, timeout, or invalid-JSON, kept distinct
rather than collapsed into pass/fail: `npm audit`'s exit code 1 means "vulnerabilities found," not
"the scanner failed," and is treated as a successful run. Both scanners are wrapped exactly as
every analyzer is: a failure becomes a diagnostic `AnalyzerOutcome`, never a thrown exception,
since a throw inside the parallel superstep would roll the whole fan-out back over one scanner's
bad day — the same constraint
[ADR-0007](0007-model-provider-abstraction-and-function-calling.md) names for model calls.

## Consequences

- A dependency advisory and a missed-context judgement call are each caught by the mechanism
  suited to it, in one pass over the PR.
- Disabling Semgrep (binary missing) or `npm audit` (offline) degrades a review; it does not fail
  it — the remaining analyzers still run and still publish.
- The curated ruleset is a maintenance surface that grows only when someone commits a rule, unlike
  the auto-updating registry it deliberately avoids.
