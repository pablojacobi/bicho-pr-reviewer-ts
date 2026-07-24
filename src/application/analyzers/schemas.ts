/**
 * Schemas for LLM analyzer output — the model boundary.
 *
 * The model returns an `AnalyzerReport` via function calling; the base analyzer validates it and
 * normalizes each `RawFinding` into a domain `Finding` (assigning ids, fingerprints, metadata).
 * Every field carries a description because those descriptions become the JSON Schema the model is
 * actually shown — they are prompt surface, not documentation.
 */

import { z } from "zod";
import { Confidence, Severity } from "../../domain/models/finding.ts";

/** A single finding as produced by an analyzer model, before normalization. */
export const rawFindingSchema = z.object({
  title: z.string().describe("A short, specific headline for the issue."),
  explanation: z.string().describe("Why this is a problem, grounded in the diff."),
  impact: z.string().describe("What goes wrong in practice if this ships."),
  recommendation: z.string().describe("The concrete change that fixes it."),
  path: z.string().describe("Repository-relative path of the file, exactly as shown in the diff."),
  startLine: z.int().min(1).describe("First line of the offending range, as numbered in the diff."),
  endLine: z
    .int()
    .min(1)
    .describe("Last line of the offending range; equal to startLine if one line."),
  severity: z.enum(Severity).describe("How serious the issue is."),
  confidence: z.enum(Confidence).describe("How sure you are that this is real."),
  subcategory: z
    .string()
    .describe("A short kebab-case slug for the issue type, e.g. sql-injection."),
  snippet: z.string().default("").describe("The offending code, copied verbatim from the diff."),
});

export type RawFinding = Readonly<z.output<typeof rawFindingSchema>>;

/** The full structured output of an analyzer model. */
export const analyzerReportSchema = z.object({
  findings: z.array(rawFindingSchema).default([]).describe("Every issue found; empty if none."),
});

export type AnalyzerReport = Readonly<z.output<typeof analyzerReportSchema>>;

/** The verifier's decision on one candidate finding, referenced by its index. */
export const findingVerdictSchema = z.object({
  index: z.int().min(0).describe("The index of the finding this verdict is about."),
  keep: z.boolean().describe("True if the finding is real and should be published."),
  reason: z.string().default("").describe("Brief justification for the decision."),
});

export type FindingVerdict = Readonly<z.output<typeof findingVerdictSchema>>;

/** The verifier model's structured output: one verdict per judged finding. */
export const verificationReportSchema = z.object({
  verdicts: z.array(findingVerdictSchema).default([]).describe("One verdict per candidate."),
});

export type VerificationReport = Readonly<z.output<typeof verificationReportSchema>>;
