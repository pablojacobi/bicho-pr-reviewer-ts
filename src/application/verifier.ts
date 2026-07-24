/**
 * Finding verification: decide which candidate findings are real before they are composed.
 *
 * Two implementations behind one interface. {@link PolicyVerifier} is the deterministic first pass:
 * it confirms confident findings and rejects low-confidence ones (no model). {@link
 * LLMFindingVerifier} adds a single **batched** model call that judges every candidate finding
 * against the diff to cut false positives; if that call fails it falls back to the policy, so it
 * never makes a review worse than the deterministic pass. Findings an earlier stage already
 * resolved (e.g. `DUPLICATE`) pass through untouched.
 */

import type { NormalizedDiff } from "../domain/models/diff.ts";
import { type Finding, VerificationState, withFinding } from "../domain/models/finding.ts";
import { type ModelProvider, makeRunMeta } from "../domain/ports/modelProvider.ts";
import { verifyByPolicy } from "../domain/services/verificationPolicy.ts";
import { renderDiff } from "./analyzers/base.ts";
import {
  type FindingVerdict,
  type VerificationReport,
  verificationReportSchema,
} from "./analyzers/schemas.ts";
import { getPrompt, PROMPT_VERSION } from "./prompts/registry.ts";

/** Decides the verification state of each finding. */
export interface FindingVerifier {
  verify(
    findings: readonly Finding[],
    options: { diff: NormalizedDiff; correlationId: string },
  ): Promise<readonly Finding[]>;
}

/** The deterministic confidence policy, applied to each candidate finding. */
export class PolicyVerifier implements FindingVerifier {
  async verify(findings: readonly Finding[]): Promise<readonly Finding[]> {
    return findings.map(verifyByPolicy);
  }
}

/** Judges candidate findings with one batched model call, falling back to the policy. */
export class LLMFindingVerifier implements FindingVerifier {
  readonly #model: ModelProvider;

  constructor(options: { model: ModelProvider }) {
    this.#model = options.model;
  }

  async verify(
    findings: readonly Finding[],
    options: { diff: NormalizedDiff; correlationId: string },
  ): Promise<readonly Finding[]> {
    const candidates = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.verificationState === VerificationState.CANDIDATE);
    if (candidates.length === 0) {
      return findings;
    }

    const result = await this.#model.structured<VerificationReport>({
      prompt: renderPrompt(options.diff, candidates),
      schema: verificationReportSchema,
      schemaName: "report_verdicts",
      meta: makeRunMeta({
        role: "verifier",
        promptVersion: PROMPT_VERSION,
        correlationId: options.correlationId,
      }),
    });

    if (!result.ok) {
      return findings.map(policyIfCandidate);
    }
    const verdicts = new Map(result.value.verdicts.map((verdict) => [verdict.index, verdict]));
    return findings.map((finding, index) => apply(finding, verdicts.get(index)));
  }
}

function policyIfCandidate(finding: Finding): Finding {
  return finding.verificationState === VerificationState.CANDIDATE
    ? verifyByPolicy(finding)
    : finding;
}

/** Apply one verdict, falling back to the policy when the model skipped this finding. */
function apply(finding: Finding, verdict: FindingVerdict | undefined): Finding {
  if (finding.verificationState !== VerificationState.CANDIDATE) {
    return finding;
  }
  if (verdict === undefined) {
    return verifyByPolicy(finding);
  }
  return withFinding(finding, {
    verificationState: verdict.keep ? VerificationState.CONFIRMED : VerificationState.REJECTED,
    verificationReason:
      verdict.reason || (verdict.keep ? "confirmed by the verifier" : "rejected by the verifier"),
  });
}

function renderPrompt(
  diff: NormalizedDiff,
  candidates: readonly { finding: Finding; index: number }[],
): string {
  const lines = [
    getPrompt("verifier"),
    "",
    "## Diff",
    renderDiff(diff),
    "",
    "## Candidate findings",
  ];
  for (const { finding, index } of candidates) {
    lines.push(
      `[${index}] (${finding.category}/${finding.severity}) ` +
        `${finding.path}:${finding.startLine} — ${finding.title}: ${finding.explanation}`,
    );
  }
  return lines.join("\n");
}
