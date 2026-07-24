# ADR-0010: TypeScript/JavaScript as the primary analysis target

- **Status:** Accepted
- **Context:** porting the reviewer from Python to Node + TypeScript

## Context

The Python implementation reviews PRs written in Python: its one concrete language adapter uses the
standard-library `ast` module for enclosing-symbol resolution, and its dependency scanner is
`pip-audit` over `requirements*.txt`.

Porting the *implementation* language to Node raised a question the original never had to answer:
what should the port *analyze*? Three options were on the table.

1. **Stay faithful — keep Python as the target.** The core is language-agnostic, so this is
   possible, but Node has no equivalent of Python's `ast`. Resolving the enclosing symbol would mean
   either a regex approximation (materially worse fingerprints, which are the mechanism that lets a
   finding survive unrelated line drift) or embedding a Python parser. The project's own rules
   already rule out Tree-sitter. The result would also be odd on its face: a Node service whose only
   competence is reviewing Python.
2. **Support both.** Doubles the adapter surface, the scanner surface and the test matrix, for a
   port whose value is demonstrating the architecture — not breadth of language coverage.
3. **Move the target to TypeScript/JavaScript.** The platform's own ecosystem has first-class
   parsers, and `npm audit` is the direct analogue of `pip-audit`.

## Decision

The primary language adapter analyzes **TypeScript and JavaScript**, and the dependency scanner is
**`npm audit`** over changed `package-lock.json` manifests, replacing `pip-audit`.

The Semgrep scanner carries over unchanged — it is language-agnostic by construction — with a
curated JS/TS ruleset in `resources/semgrep/typescript/`.

Nothing in `domain/` or `application/` changed to accommodate this. The swap is confined to
`infrastructure/language/` and `infrastructure/scanners/`, which is the evidence that the
language-agnostic core was real and not aspirational.

## Consequences

- The port is idiomatic: a Node service that reviews Node code, dogfooding its own ecosystem.
- `SourceKind.PIP_AUDIT` becomes `SourceKind.NPM_AUDIT`; `Category.DEPENDENCY` is unchanged.
- A Python adapter remains possible later without touching the core — it would be one new file in
  `infrastructure/language/` and one entry in the registry.
- The two implementations are no longer interchangeable on the *same* repository. They are two
  instances of one architecture pointed at different ecosystems, which is the honest description.
- `npm audit` needs a `package.json` beside the lockfile to run at all, so the scanner synthesizes a
  stub when the PR changed only the lockfile. This is a scanner-local workaround, documented in
  place.
