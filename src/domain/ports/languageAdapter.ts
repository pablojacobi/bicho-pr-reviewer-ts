/** Port for language-specific behaviour, keeping the review core language-agnostic. */

import type { ChangedFile } from "../models/pullRequest.ts";

/**
 * Language-specific hooks that keep the core language-agnostic.
 *
 * - `language`: the adapter's language name.
 * - `score`: how strongly the adapter applies to the changed files (0.0 = not at all).
 * - `inScope`: whether a file is one this adapter analyzes.
 * - `defaultAnalyzers`: analyzer names to run for this language.
 * - `enclosingSymbol`: the function/class enclosing a line, for stable fingerprints.
 */
export interface LanguageAdapter {
  readonly language: string;

  score(files: readonly ChangedFile[]): number;
  inScope(file: ChangedFile): boolean;
  defaultAnalyzers(): readonly string[];
  enclosingSymbol(path: string, content: string, line: number): string | null;
}

/** Selects the best-fitting {@link LanguageAdapter} for a set of changed files. */
export interface LanguageAdapterRegistry {
  select(files: readonly ChangedFile[]): LanguageAdapter;
}
