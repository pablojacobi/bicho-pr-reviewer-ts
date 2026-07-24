/**
 * The analyzer registry: the roles Bicho runs and how to build them.
 *
 * Each role maps to a finding {@link Category} and shares the one {@link LLMAnalyzer} implementation
 * (only the role's prompt differs). {@link buildAnalyzers} is the single place the composition root
 * and tests use to assemble the full set, so a new analyzer is added here and in the prompt
 * registry — nowhere else.
 */

import { Category } from "../../domain/models/finding.ts";
import type { ModelProvider } from "../../domain/ports/modelProvider.ts";
import type { IdGenerator } from "../../domain/ports/system.ts";
import { type Analyzer, LLMAnalyzer } from "./base.ts";

export const ANALYZER_CATEGORIES: Readonly<Record<string, Category>> = {
  correctness: Category.CORRECTNESS,
  security: Category.SECURITY,
  performance: Category.PERFORMANCE,
  maintainability: Category.MAINTAINABILITY,
  tests: Category.TESTS,
  contracts: Category.CONTRACTS,
};

/** Build every LLM analyzer, keyed by role name. */
export function buildAnalyzers(options: {
  model: ModelProvider;
  ids: IdGenerator;
}): Map<string, Analyzer> {
  return new Map(
    Object.entries(ANALYZER_CATEGORIES).map(([role, category]) => [
      role,
      new LLMAnalyzer({ role, category, model: options.model, ids: options.ids }),
    ]),
  );
}
