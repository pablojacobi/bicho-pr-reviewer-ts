/**
 * A test-only language adapter.
 *
 * Running the whole graph through an adapter that knows nothing about any real language is what
 * proves the core is not coupled to one — the same role the Python original's dummy adapter played.
 */

import type { ChangedFile } from "../../src/domain/models/pullRequest.ts";
import type {
  LanguageAdapter,
  LanguageAdapterRegistry,
} from "../../src/domain/ports/languageAdapter.ts";

export class DummyAdapter implements LanguageAdapter {
  readonly language = "dummy";
  readonly #analyzers: readonly string[];
  readonly #symbol: string | null;

  constructor(options: { analyzers?: readonly string[]; symbol?: string | null } = {}) {
    this.#analyzers = options.analyzers ?? ["correctness", "security"];
    this.#symbol = options.symbol ?? null;
  }

  score(files: readonly ChangedFile[]): number {
    return files.length > 0 ? 1 : 0;
  }

  inScope(file: ChangedFile): boolean {
    return file.patch !== null;
  }

  defaultAnalyzers(): readonly string[] {
    return this.#analyzers;
  }

  enclosingSymbol(): string | null {
    return this.#symbol;
  }
}

/** A registry that always hands back the one adapter it was built with. */
export class FixedAdapterRegistry implements LanguageAdapterRegistry {
  readonly #adapter: LanguageAdapter;

  constructor(adapter: LanguageAdapter) {
    this.#adapter = adapter;
  }

  select(): LanguageAdapter {
    return this.#adapter;
  }
}
