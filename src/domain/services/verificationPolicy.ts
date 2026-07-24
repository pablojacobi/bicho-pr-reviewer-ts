/**
 * A deterministic first-pass verification policy.
 *
 * The contextual (LLM) verifier layers on top of this; on its own this promotes confident findings
 * to CONFIRMED and rejects low-confidence ones, so only vetted findings reach composition.
 */

import { Confidence, type Finding, VerificationState, withFinding } from "../models/finding.ts";

/**
 * Return the finding with its verification state decided by the policy.
 *
 * Only `CANDIDATE` findings are judged here; a finding an earlier pass already resolved (e.g. a
 * `DUPLICATE` from deduplication) is left untouched, so it is never promoted back to CONFIRMED.
 */
export function verifyByPolicy(finding: Finding): Finding {
  if (finding.verificationState !== VerificationState.CANDIDATE) {
    return finding;
  }
  if (finding.confidence === Confidence.LOW) {
    return withFinding(finding, {
      verificationState: VerificationState.REJECTED,
      verificationReason: "confidence below threshold for the first-pass policy",
    });
  }
  return withFinding(finding, {
    verificationState: VerificationState.CONFIRMED,
    verificationReason: "confirmed by the first-pass policy",
  });
}
