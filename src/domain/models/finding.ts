/**
 * The normalized Finding — the single shape every scanner and analyzer produces.
 *
 * A finding carries everything needed to verify it, deduplicate it, decide whether it can be
 * published, and render it as a GitHub review comment. Only findings in the `CONFIRMED` state are
 * ever published; the publish-gate predicates live here so composition never re-derives them.
 *
 * Findings are plain, frozen data records rather than class instances: they travel through
 * LangGraph state, so they must stay trivially serializable. The Python original expressed the
 * gates as Pydantic computed properties; here they are free functions over the record.
 */

import { z } from "zod";

/** Top-level finding category (drives analyzer routing and grouping). */
export const Category = {
  CORRECTNESS: "correctness",
  SECURITY: "security",
  PERFORMANCE: "performance",
  MAINTAINABILITY: "maintainability",
  TESTS: "tests",
  CONTRACTS: "contracts",
  DEPENDENCY: "dependency",
} as const;
export type Category = (typeof Category)[keyof typeof Category];

/** Finding severity, ordered by {@link severityRank} (higher is more severe). */
export const Severity = {
  INFO: "info",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/** A total order over severities, used when merging and prioritizing findings. */
export const severityRank: Readonly<Record<Severity, number>> = {
  [Severity.INFO]: 0,
  [Severity.LOW]: 1,
  [Severity.MEDIUM]: 2,
  [Severity.HIGH]: 3,
  [Severity.CRITICAL]: 4,
};

/** How confident we are that a finding is real (adjusted by the verifier). */
export const Confidence = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/** Which side of the diff a location refers to, in GitHub's terms. */
export const DiffSide = {
  LEFT: "LEFT",
  RIGHT: "RIGHT",
} as const;
export type DiffSide = (typeof DiffSide)[keyof typeof DiffSide];

/** What produced a finding. */
export const SourceKind = {
  LLM_ANALYZER: "llm_analyzer",
  SEMGREP: "semgrep",
  NPM_AUDIT: "npm_audit",
} as const;
export type SourceKind = (typeof SourceKind)[keyof typeof SourceKind];

/** A finding's lifecycle state; only `CONFIRMED` findings are published. */
export const VerificationState = {
  CANDIDATE: "candidate",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
  NEEDS_CONTEXT: "needs_context",
  OUT_OF_SCOPE: "out_of_scope",
  CANNOT_ANCHOR: "cannot_anchor",
  STALE: "stale",
} as const;
export type VerificationState = (typeof VerificationState)[keyof typeof VerificationState];

/** A pointer to supporting evidence (a caller, a schema, a test, a scanner hit). */
export const evidenceRefSchema = z.object({
  path: z.string(),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  detail: z.string(),
});
export type EvidenceRef = Readonly<z.infer<typeof evidenceRefSchema>>;

/** A single, normalized review finding produced by a scanner or analyzer. */
export const findingSchema = z
  .object({
    id: z.string(),
    fingerprint: z.string(),
    category: z.enum(Category),
    subcategory: z.string(),
    severity: z.enum(Severity),
    confidence: z.enum(Confidence),
    title: z.string(),
    explanation: z.string(),
    impact: z.string(),
    recommendation: z.string(),
    path: z.string(),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    diffSide: z.enum(DiffSide).default(DiffSide.RIGHT),
    snippet: z.string().default(""),
    evidence: z.array(evidenceRefSchema).default([]),
    sourceKind: z.enum(SourceKind),
    sourceName: z.string(),
    verificationState: z.enum(VerificationState).default(VerificationState.CANDIDATE),
    verificationReason: z.string().nullable().default(null),
    headSha: z.string(),
    promptVersion: z.string().nullable().default(null),
    modelId: z.string().nullable().default(null),
    language: z.string(),
    framework: z.string().nullable().default(null),
    canPublishInline: z.boolean().default(true),
    summaryOnly: z.boolean().default(false),
  })
  .refine((finding) => finding.endLine >= finding.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export type Finding = Readonly<z.output<typeof findingSchema>>;
export type FindingInput = z.input<typeof findingSchema>;

/** Validate and build a {@link Finding}, applying defaults and the line-range invariant. */
export function makeFinding(input: FindingInput): Finding {
  return findingSchema.parse(input);
}

/** Return a copy of `finding` with `update` applied, re-validating the result. */
export function withFinding(finding: Finding, update: Partial<FindingInput>): Finding {
  return makeFinding({ ...finding, ...update });
}

/** Whether this finding passed verification and may be published at all. */
export function isConfirmed(finding: Finding): boolean {
  return finding.verificationState === VerificationState.CONFIRMED;
}

/** Whether to publish this finding as an inline comment on the diff. */
export function publishInline(finding: Finding): boolean {
  return isConfirmed(finding) && finding.canPublishInline && !finding.summaryOnly;
}

/** Whether to publish this finding in the review summary instead of inline. */
export function publishInSummary(finding: Finding): boolean {
  return isConfirmed(finding) && (finding.summaryOnly || !finding.canPublishInline);
}
