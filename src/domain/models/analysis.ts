/**
 * Analyzer/scanner outcomes — the fan-in vocabulary of the review graph.
 *
 * Every scanner and analyzer returns an `AnalyzerOutcome` instead of throwing, so failures degrade
 * to a diagnostic rather than aborting the parallel superstep (LangGraph rolls a superstep back if
 * any branch throws). `composeReview` surfaces the diagnostics; nothing is hidden.
 */

import type { Finding } from "./finding.ts";

/** The result of running one analyzer or scanner. */
export const OutcomeStatus = {
  OK: "ok",
  ZERO_FINDINGS: "zero_findings",
  ERROR: "error",
  TIMEOUT: "timeout",
  SKIPPED: "skipped",
} as const;
export type OutcomeStatus = (typeof OutcomeStatus)[keyof typeof OutcomeStatus];

const DEGRADED: ReadonlySet<OutcomeStatus> = new Set([
  OutcomeStatus.ERROR,
  OutcomeStatus.TIMEOUT,
  OutcomeStatus.SKIPPED,
]);

/** A note about a degraded analyzer/scanner run, surfaced in the review summary. */
export interface Diagnostic {
  readonly source: string;
  readonly status: OutcomeStatus;
  readonly message: string;
}

/** What one analyzer or scanner produced: findings, diagnostics, and a status. */
export interface AnalyzerOutcome {
  readonly source: string;
  readonly status: OutcomeStatus;
  readonly findings: readonly Finding[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Build an {@link AnalyzerOutcome}, defaulting the two collections to empty. */
export function makeOutcome(outcome: {
  source: string;
  status: OutcomeStatus;
  findings?: readonly Finding[];
  diagnostics?: readonly Diagnostic[];
}): AnalyzerOutcome {
  return {
    source: outcome.source,
    status: outcome.status,
    findings: outcome.findings ?? [],
    diagnostics: outcome.diagnostics ?? [],
  };
}

/** Whether this outcome is a failure/timeout/skip that should be surfaced to the reader. */
export function isDegraded(outcome: AnalyzerOutcome): boolean {
  return DEGRADED.has(outcome.status);
}
