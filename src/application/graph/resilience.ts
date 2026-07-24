/**
 * The resilient node wrapper — analyzer/scanner nodes degrade instead of throwing.
 *
 * In LangGraph, if any branch of a parallel superstep throws, the whole superstep is rolled back
 * and the run errors. So every analyzer/scanner node is wrapped here: any exception becomes an
 * ERROR `AnalyzerOutcome` written to the `outcomes` reducer, and the superstep completes normally.
 * Degrade and report; never hide.
 */

import { type AnalyzerOutcome, makeOutcome, OutcomeStatus } from "../../domain/models/analysis.ts";
import type { ReviewStateUpdate } from "./state.ts";

/** Wrap an analyzer run so any exception degrades to an ERROR outcome, never rolling back. */
export async function resilientOutcome(
  source: string,
  run: () => Promise<AnalyzerOutcome>,
): Promise<ReviewStateUpdate> {
  let outcome: AnalyzerOutcome;
  try {
    outcome = await run();
  } catch (error) {
    // Deliberately broad: degrade, never abort the parallel superstep.
    outcome = makeOutcome({
      source,
      status: OutcomeStatus.ERROR,
      diagnostics: [{ source, status: OutcomeStatus.ERROR, message: describeError(error) }],
    });
  }
  return { outcomes: [outcome] };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
