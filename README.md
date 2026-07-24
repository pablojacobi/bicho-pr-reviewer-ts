# Bicho PR Reviewer

> Automated GitHub Pull Request review agent — it gathers PR context, runs deterministic scanners
> plus LLM-based specialized analyzers, **verifies** findings to cut false positives, and publishes
> a **single** GitHub Review. *(bicho — Spanish for "critter".)*

This is the **Node + TypeScript** implementation, a port of
[bicho-pr-reviewer](https://github.com/pablojacobi/bicho-pr-reviewer) (Python/FastAPI/LangGraph).
It is being built layer by layer; this commit is the project skeleton and its configuration.

## Stack

Node 24+ (ESM) · TypeScript 7 (strict) · Zod 4 · Vitest 4 · Biome 2.

## Commands

```bash
npm install
npm test           # Vitest + the 100% line/branch coverage gate
npm run typecheck  # tsc --noEmit, strict
npm run lint       # Biome (lint + format check)
npm run build      # compile to dist/
```

## Configuration

Every setting is read from the environment with the `BICHO_` prefix; nested sections use a `__`
delimiter (`BICHO_GITHUB__APP_ID`). See [.env.example](.env.example) for the full reference. The
contract is identical to the Python implementation, so a single environment configures either.

## License

[MIT](LICENSE).
