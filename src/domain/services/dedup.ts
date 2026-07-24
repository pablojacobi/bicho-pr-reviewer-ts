/**
 * Deduplication of findings that share a fingerprint.
 *
 * Findings with the same fingerprint describe the same issue, possibly surfaced by different
 * sources (e.g. Semgrep and an LLM analyzer). We keep one survivor — enriched with the others'
 * evidence and, when corroborated by an independent source, a raised confidence — and mark the rest
 * `DUPLICATE` (retained for logging, never published). The result is deterministic regardless of
 * input order.
 */

import {
  Confidence,
  type EvidenceRef,
  type Finding,
  SourceKind,
  severityRank,
  VerificationState,
  withFinding,
} from "../models/finding.ts";

const CONFIDENCE_ORDER: readonly Confidence[] = [
  Confidence.LOW,
  Confidence.MEDIUM,
  Confidence.HIGH,
];
const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  [Confidence.LOW]: 0,
  [Confidence.MEDIUM]: 1,
  [Confidence.HIGH]: 2,
};
const SOURCE_PRIORITY: Readonly<Record<SourceKind, number>> = {
  [SourceKind.SEMGREP]: 2,
  [SourceKind.NPM_AUDIT]: 1,
  [SourceKind.LLM_ANALYZER]: 0,
};

/** Merge same-fingerprint findings: enriched survivors plus losers marked `DUPLICATE`. */
export function deduplicate(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.fingerprint);
    if (group === undefined) {
      groups.set(finding.fingerprint, [finding]);
    } else {
      group.push(finding);
    }
  }

  const result: Finding[] = [];
  for (const group of groups.values()) {
    const first = group[0] as Finding;
    if (group.length === 1) {
      result.push(first);
      continue;
    }
    const survivor = selectSurvivor(group);
    const losers = group.filter((finding) => finding.id !== survivor.id);
    result.push(enrich(survivor, losers));
    result.push(...losers.map((loser) => markDuplicate(loser, survivor)));
  }
  return result;
}

/** Best = highest severity, then confidence, then source priority; ties broken by lowest id. */
function selectSurvivor(group: readonly Finding[]): Finding {
  const ordered = [...group].sort(
    (a, b) =>
      severityRank[b.severity] - severityRank[a.severity] ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      SOURCE_PRIORITY[b.sourceKind] - SOURCE_PRIORITY[a.sourceKind] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ordered[0] as Finding;
}

/**
 * Enrich the survivor with the group's evidence, and raise its confidence when corroborated.
 *
 * The survivor's severity is already the group maximum — severity is the primary sort key in
 * {@link selectSurvivor} — so there is nothing to lift. (The Python original recomputed the maximum
 * here; it was provably a no-op, and reproducing it would leave a branch no input can exercise.)
 */
function enrich(survivor: Finding, losers: readonly Finding[]): Finding {
  const corroborated = losers.some((loser) => loser.sourceKind !== survivor.sourceKind);
  return withFinding(survivor, {
    evidence: mergeEvidence([survivor, ...losers]),
    confidence: corroborated ? raiseConfidence(survivor.confidence) : survivor.confidence,
  });
}

function mergeEvidence(findings: readonly Finding[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const finding of findings) {
    for (const reference of finding.evidence) {
      // Structural identity: the Python original deduplicated frozen models by value.
      seen.set(JSON.stringify(reference), reference);
    }
  }
  return [...seen.values()];
}

function raiseConfidence(confidence: Confidence): Confidence {
  const index = Math.min(CONFIDENCE_RANK[confidence] + 1, CONFIDENCE_ORDER.length - 1);
  return CONFIDENCE_ORDER[index] as Confidence;
}

function markDuplicate(loser: Finding, survivor: Finding): Finding {
  return withFinding(loser, {
    verificationState: VerificationState.DUPLICATE,
    verificationReason: `merged into ${survivor.id}`,
  });
}
