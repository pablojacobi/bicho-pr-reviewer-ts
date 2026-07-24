/**
 * Validated subset of `npm audit --package-lock-only --json` output (npm 7+ report format).
 *
 * `vulnerabilities` is an object keyed by package name, not an array — a shape npm inherited from how
 * it groups advisories per dependency. Each entry's `via` is itself a mixed list: a plain string names
 * an intermediate package in a transitive chain, while an object is the advisory that actually applies
 * to *this* package. Only the fields the runner reads are modeled; everything else (and any future npm
 * report field) is ignored rather than rejected.
 */

import { z } from "zod";

/**
 * One `via` entry.
 *
 * A bare string is the name of a dependency this vulnerability was pulled in through (a transitive
 * hit); an object is the advisory itself, attached to the package that is directly vulnerable.
 */
const npmAuditViaEntrySchema = z.union([
  z.string(),
  z.object({
    source: z.number().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    severity: z.string().optional(),
  }),
]);
export type NpmAuditVia = z.output<typeof npmAuditViaEntrySchema>;

/** Either "yes, a fix exists" (boolean) or the specific version npm would upgrade to (object). */
const npmAuditFixAvailableSchema = z.union([
  z.boolean(),
  z.object({
    name: z.string(),
    version: z.string(),
  }),
]);
export type NpmAuditFixAvailable = z.output<typeof npmAuditFixAvailableSchema>;

/** One entry of the `vulnerabilities` map. */
const npmAuditVulnerabilitySchema = z.object({
  name: z.string(),
  severity: z.string(),
  via: z.array(npmAuditViaEntrySchema).default([]),
  range: z.string().optional(),
  fixAvailable: npmAuditFixAvailableSchema.optional(),
});
export type NpmAuditVulnerability = Readonly<z.output<typeof npmAuditVulnerabilitySchema>>;

/** The top-level report shape produced by `npm audit --json`. */
export const npmAuditOutputSchema = z.object({
  vulnerabilities: z.record(z.string(), npmAuditVulnerabilitySchema).default({}),
});
export type NpmAuditOutput = Readonly<z.output<typeof npmAuditOutputSchema>>;

/**
 * Parse and validate raw `npm audit --json` stdout, tolerating nothing malformed.
 *
 * Both a JSON syntax error and a schema mismatch collapse to `null` here: the caller turns either into
 * the same "could not parse" diagnostic, named after the manifest that produced it.
 */
export function parseNpmAuditOutput(raw: string): NpmAuditOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = npmAuditOutputSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
