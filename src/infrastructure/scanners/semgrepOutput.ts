/**
 * Validated subset of `semgrep scan --json` output.
 *
 * Semgrep's JSON report carries far more than we need (paths metadata, rule provenance, timing,
 * skipped-files diagnostics, …). Modeling only the fields the runner actually consumes — and letting
 * everything else pass through unvalidated — means an upstream Semgrep upgrade that adds new keys
 * never breaks us; only a *shape* change to the fields we read does, and that degrades to `null`
 * rather than throwing, per the "never throw" contract every scanner has to uphold.
 */

import { z } from "zod";

/** A 1-based source position, as Semgrep reports `start`/`end`. */
const semgrepPositionSchema = z.object({
  line: z.number(),
});

/**
 * The subset of `extra` we read.
 *
 * Both fields are optional and the whole object defaults to `{}`: older/customized rules sometimes
 * omit `message`, and `severity` is absent for match kinds semgrep doesn't grade.
 */
const semgrepExtraSchema = z
  .object({
    message: z.string().optional(),
    severity: z.string().optional(),
  })
  .default({});

/** One match from `results`. */
const semgrepResultSchema = z.object({
  check_id: z.string(),
  path: z.string(),
  start: semgrepPositionSchema,
  end: semgrepPositionSchema,
  extra: semgrepExtraSchema,
});
export type SemgrepResult = Readonly<z.output<typeof semgrepResultSchema>>;

/** The top-level report shape produced by `semgrep scan --json`. */
export const semgrepOutputSchema = z.object({
  results: z.array(semgrepResultSchema).default([]),
});
export type SemgrepOutput = Readonly<z.output<typeof semgrepOutputSchema>>;

/**
 * Parse and validate raw `semgrep scan --json` stdout, tolerating nothing malformed.
 *
 * Both a JSON syntax error and a schema mismatch collapse to `null` here: the caller turns either
 * into the same "could not parse" diagnostic, since neither is actionable by the reviewer beyond
 * knowing the scanner's output could not be trusted.
 */
export function parseSemgrepOutput(raw: string): SemgrepOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = semgrepOutputSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
