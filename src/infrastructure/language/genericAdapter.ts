/**
 * The language-agnostic fallback adapter.
 *
 * Selected when no language-specific adapter fits, so a PR touching an unrecognized language still
 * gets reviewed with the core (non-language-aware) analyzers instead of being silently skipped. It has
 * no way to parse any particular grammar, so it never resolves an enclosing symbol; fingerprints for
 * its findings fall back to path + code shape instead of a function/class name.
 */

import type { ChangedFile } from "../../domain/models/pullRequest.ts";
import type { LanguageAdapter } from "../../domain/ports/languageAdapter.ts";
import { isGeneratedOrVendored, isSafeRelativePath } from "../fs/pathsafe.ts";

/**
 * Analyzer names every adapter runs unless it has a specific reason to diverge.
 *
 * Defined once and reused by {@link GenericAdapter} and the language-specific adapters so the list
 * cannot drift out of sync between them by editing one copy and forgetting the other.
 */
export const DEFAULT_ANALYZERS = [
  "correctness",
  "security",
  "performance",
  "maintainability",
  "tests",
  "contracts",
  "semgrep",
  "npm-audit",
] as const;

/**
 * The fallback {@link LanguageAdapter}, used by {@link LanguageAdapterRegistry} when nothing else
 * scores above zero.
 *
 * Scoring just above zero — rather than zero — for any non-empty file set means a PR touching only
 * files no adapter recognizes still outscores "nothing selected" and gets reviewed, while staying low
 * enough that any adapter which actually recognizes the language always wins selection instead.
 */
export class GenericAdapter implements LanguageAdapter {
  readonly language = "generic";

  score(files: readonly ChangedFile[]): number {
    return files.length > 0 ? 0.1 : 0.0;
  }

  inScope(file: ChangedFile): boolean {
    return (
      file.patch !== null &&
      isSafeRelativePath(file.filename) &&
      !isGeneratedOrVendored(file.filename)
    );
  }

  defaultAnalyzers(): readonly string[] {
    return DEFAULT_ANALYZERS;
  }

  /** Always `null`: the generic adapter has no grammar to parse, so it names no symbols. */
  enclosingSymbol(): string | null {
    return null;
  }
}
