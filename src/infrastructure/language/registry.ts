/**
 * Selects the best-fitting language adapter for a set of changed files, falling back to a generic one
 * when nothing scores above zero.
 */

import type { ChangedFile } from "../../domain/models/pullRequest.ts";
import type {
  LanguageAdapter,
  LanguageAdapterRegistry,
} from "../../domain/ports/languageAdapter.ts";

/**
 * Holds the candidate adapters plus a fallback and implements selection as "highest score wins."
 *
 * Candidates are tried in the order given, and a later adapter only displaces the current best on a
 * strictly higher score. So when two adapters score identically on the same files, the first one
 * registered wins — deterministic selection without needing a separate tie-break rule.
 */
export class AdapterRegistry implements LanguageAdapterRegistry {
  readonly #adapters: readonly LanguageAdapter[];
  readonly #fallback: LanguageAdapter;

  constructor(adapters: readonly LanguageAdapter[], options: { fallback: LanguageAdapter }) {
    this.#adapters = adapters;
    this.#fallback = options.fallback;
  }

  select(files: readonly ChangedFile[]): LanguageAdapter {
    let best: LanguageAdapter | null = null;
    let bestScore = 0.0;
    for (const adapter of this.#adapters) {
      const score = adapter.score(files);
      if (score > bestScore) {
        bestScore = score;
        best = adapter;
      }
    }
    return best ?? this.#fallback;
  }
}
