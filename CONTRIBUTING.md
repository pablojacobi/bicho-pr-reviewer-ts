# Contributing

[AGENTS.md](AGENTS.md) is the source of truth for working in this repository — architecture,
non-negotiables, testing discipline, security rules, and commit conventions. Read it before making
a change. This file only summarises the mechanics of sending one.

## Before you push

Run the same gate CI runs:

```bash
npm test           # tests + the 100% line+branch gate (config in vitest.config.ts)
npm run typecheck  # tsc --noEmit, strict
npm run lint       # Biome lint + format check (`npm run lint:fix` to apply)
```

All three must be clean. Branch protection on `main` enforces this through
`.github/workflows/ci.yml`; running it locally first is faster than waiting for CI to tell you.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `refactor`, `test`,
`docs`, `perf`, `security`, `build`, `ci`, `chore`, `revert`. Imperative mood, one logical unit per
commit. Keep a lockfile change in the same commit as the dependency change that caused it. Never
commit secrets or a failing test.

## Branches and pull requests

Work on `feat/…`, `fix/…`, or `docs/…` branches — never directly on `main`. Keep pull requests
small and reviewable: one that bundles an unrelated refactor with a feature is harder to review and
harder to revert. Pull requests are squash-merged, so the PR title becomes the commit message on
`main` — write it as you would a commit.

## Definition of Done

A change is done when: the implementation is complete; tests were written first and pass; coverage
is 100% line and branch; Biome and `tsc` are clean; docs and ADRs are updated in the same PR;
security has been considered (see [SECURITY.md](SECURITY.md)); commits follow Conventional
Commits; CI is green; and nothing in the diff is a secret.

Record a significant architectural decision as a new ADR under [docs/adr/](docs/adr/), following
the format of the existing ones — see
[ADR-0001](docs/adr/0001-use-architecture-decision-records.md).
