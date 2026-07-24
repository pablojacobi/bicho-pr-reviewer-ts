# ADR-0005: 100% line and branch coverage, and TDD

- **Status:** Accepted
- **Context:** setting the coverage gate and development discipline for `src/`

## Context

Bicho decides what gets posted on someone else's pull request, unattended, on a webhook trigger. A
false positive erodes trust in every review after it; a silent failure in an untested error path
means a real problem ships un-flagged, and nothing breaks loudly enough for anyone to notice. That
risk profile argues for treating test coverage as a forcing function rather than a vanity metric,
and for writing the test before the code it tests rather than after.

100% coverage does not prove correctness — a line can execute under a test that asserts nothing
meaningful, and coverage cannot see a semantic bug at all. That gap is real, and worth naming
rather than glossing over. What 100%, specifically **line and branch**, coverage does buy is
different: it makes every *unreached* branch and every *untested* error path visible by
construction, because the build fails the moment one exists. A lower bar — 80%, "the important
parts" — lets exactly the code most likely to be wrong (error handling, edge cases, the paths
nobody thinks to exercise) hide in the uncovered remainder.

## Decision

`vitest.config.ts` gates `npm test` at 100% lines, branches, functions, and statements over
`src/`, enforced in CI (`.github/workflows/ci.yml`) and by branch protection. Development follows
red-green-refactor: write the failing test first, confirm it fails for the right reason, then
implement (AGENTS.md's non-negotiable #1). When a branch genuinely cannot be reached — dead
defensive code, a condition the type system already rules out — the rule is to **simplify the code
to remove the branch**, never to exclude it from the report. A file-level exclusion is the last
resort, and each one is justified in `vitest.config.ts` itself (`src/main.ts`, which only binds a
port, and `*.types.ts`, which emits no executable code).

## Consequences

- Every side effect — clock, ids, subprocess, filesystem, network — sits behind an injectable
  port, so the suite can reach 100% with no real network, credentials, model, or scanner binary;
  determinism is the reason this is possible, not an incidental benefit.
- The gate blocks merges, so an untested error path cannot ship even under deadline pressure.
- Coverage is a floor, not a substitute for judgement: a test that executes a line without
  asserting its behaviour still satisfies the gate and still ships a hole. Reviewers still have to
  read tests, not just their coverage percentage.
