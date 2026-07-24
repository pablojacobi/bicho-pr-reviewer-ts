# ADR-0006: Language-agnostic core with adapters

- **Status:** Accepted
- **Context:** keeping the review core independent of any one programming language

## Context

Bicho's pipeline — fetch, diff, select analyzers, fan out, verify, compose, publish — has nothing
to do with any particular programming language. What *is* language-specific is narrow: which
changed files an adapter should look at, which analyzers make sense to run, and resolving the
function or class enclosing a line, for fingerprint stability (see
[ADR-0011](0011-oxc-parser-for-symbol-resolution.md)). Left unchecked, that narrow surface tends
to leak — a parser import here, an `if (language === "python")` branch there — until the core is
quietly coupled to one ecosystem and every test needs a real file in that language to run at all.

## Decision

Everything language-specific sits behind one port, `LanguageAdapter`
(`src/domain/ports/languageAdapter.ts`): `score` (how well this adapter fits a set of changed
files), `inScope`, `defaultAnalyzers`, and `enclosingSymbol`. `AdapterRegistry` selects the
highest-scoring adapter and falls back to a `GenericAdapter` that recognizes no grammar but still
runs the non-language-aware analyzers, so a PR in an unsupported language is reviewed, not silently
skipped. `domain/` and `application/` depend only on this interface, never on a concrete adapter.

The proof this boundary is real, not aspirational, is `tests/helpers/dummyAdapter.ts`: a
`DummyAdapter` that knows nothing about any actual grammar, wired into the end-to-end tests that
run the *entire* graph. If the core needed anything from a real language beyond the port's four
methods, that test would fail.

## Consequences

- Adding a language is a new adapter plus a registry entry; nothing upstream changes.
  [ADR-0010](0010-typescript-as-the-primary-analysis-target.md) is the load-bearing evidence this
  held under real pressure: moving the primary analysis target from Python to TypeScript/JavaScript
  touched only `infrastructure/language/` and `infrastructure/scanners/`.
- The generic adapter's low-but-nonzero score is a deliberate tie-break, not an oversight: some
  review is better than none for an unrecognized language, but a real adapter always wins
  selection when one applies.
- Symbol resolution degrades to `null` rather than failing when an adapter cannot parse a file;
  fingerprints fall back to path and code shape instead of an enclosing symbol name.
