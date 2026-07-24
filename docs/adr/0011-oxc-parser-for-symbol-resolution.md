# ADR-0011: `oxc-parser` for enclosing-symbol resolution

- **Status:** Accepted
- **Context:** implementing the TypeScript language adapter

## Context

A finding's fingerprint includes the name of the function or class that encloses it. That is what
lets the same issue be recognised across re-runs when unrelated edits elsewhere in the file shift
line numbers. Getting it requires parsing untrusted repository source into an AST.

The obvious candidate was the TypeScript compiler's own API, the direct analogue of Python's `ast`.
Inspecting the installed package showed that TypeScript 7 — the native compiler — does not expose it
the way TypeScript 5 did:

- The package's main entrypoint resolves to `lib/version.cjs`. `ts.createSourceFile`,
  `ts.SyntaxKind` and `ts.forEachChild` are all `undefined`.
- Parsing lives behind `typescript/unstable/ast` and `typescript/unstable/sync`, explicitly named
  **unstable**.

Building a load-bearing production path — fingerprint stability — on an entrypoint whose own name
disclaims stability is a poor trade, and it would drag the whole compiler into the runtime image for
one function.

## Decision

Use **`oxc-parser`** for enclosing-symbol resolution in the TypeScript language adapter.
`typescript` stays a dev dependency: it compiles the project and nothing more.

It fits the requirement well:

- Purpose-built for tools that need to parse TS/JSX without a type checker; a stable, documented API.
- Returns an ESTree-shaped AST, so the walk is ordinary JavaScript with no compiler concepts.
- **Reports syntax errors as data** (`result.errors`) rather than throwing — which matches the
  invariant that everything touching repository content degrades instead of failing, since a PR
  routinely contains a file that does not fully parse.
- Native and fast, which matters because this runs per finding.

## Consequences

- The adapter converts a 1-based line number into the character offsets the AST carries. Those
  offsets are **UTF-16 code units**, matching native JavaScript string indexing, so line offsets are
  accumulated with plain `.length`. This was verified against the installed parser rather than
  assumed: many Rust-backed tools report UTF-8 byte offsets, and computing them that way here would
  silently misalign every symbol lookup on a line that follows non-ASCII content. A test parses a
  file containing an accented character, a BMP symbol and an astral-plane emoji to pin the
  behaviour down.
- `oxc-parser` ships prebuilt native binaries per platform as optional dependencies. `npm ci`
  resolves the right one; the Docker build gets the linux binary.
- If TypeScript's AST API stabilises, swapping back is confined to one file behind the
  `LanguageAdapter` port.
