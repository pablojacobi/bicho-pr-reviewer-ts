/**
 * Compose a single `ReviewDraft` from verified findings.
 *
 * Only CONFIRMED findings are published. Each is anchored to the diff: anchorable ones become
 * inline comments, the rest are listed in the summary so a real finding is never silently dropped
 * just because GitHub would not accept a comment there. A hidden marker is embedded for idempotency.
 */

import { createHash } from "node:crypto";
import { type AnalyzerOutcome, isDegraded } from "../../domain/models/analysis.ts";
import type { NormalizedDiff } from "../../domain/models/diff.ts";
import {
  type Finding,
  isConfirmed,
  publishInline,
  publishInSummary,
} from "../../domain/models/finding.ts";
import { type ReviewMarker, renderMarker } from "../../domain/models/marker.ts";
import type { PullRequest } from "../../domain/models/pullRequest.ts";
import {
  type InlineComment,
  makeInlineComment,
  type ReviewDraft,
} from "../../domain/models/review.ts";
import { anchorFindings } from "../../domain/services/locations.ts";
import { reviewEvent } from "../../domain/services/severityPolicy.ts";
import { PROMPT_VERSION } from "../prompts/registry.ts";

export const WORKFLOW_VERSION = "1";

/** Assemble the review: inline comments for anchorable findings, the rest in the summary. */
export function composeReviewDraft(input: {
  findings: readonly Finding[];
  diff: NormalizedDiff;
  pullRequest: PullRequest;
  outcomes: readonly AnalyzerOutcome[];
}): ReviewDraft {
  const confirmed = anchorFindings(input.findings.filter(isConfirmed), input.diff);
  const inline = confirmed.filter(publishInline).map(toComment);
  const summaryOnly = confirmed.filter(publishInSummary);
  const marker: ReviewMarker = {
    headSha: input.pullRequest.headSha,
    workflowVersion: WORKFLOW_VERSION,
    runFingerprint: runFingerprint(input.pullRequest.headSha),
    modelId: modelIdOf(confirmed),
    promptVersion: PROMPT_VERSION,
  };
  return {
    summary: renderSummary(confirmed, summaryOnly, input.outcomes, marker),
    event: reviewEvent(confirmed),
    commitId: input.pullRequest.headSha,
    inlineComments: inline,
  };
}

function toComment(finding: Finding): InlineComment {
  const multiline = finding.startLine !== finding.endLine;
  return makeInlineComment({
    path: finding.path,
    line: finding.endLine,
    side: finding.diffSide,
    body: commentBody(finding),
    startLine: multiline ? finding.startLine : null,
    startSide: multiline ? finding.diffSide : null,
  });
}

function commentBody(finding: Finding): string {
  return (
    `**[${finding.category} · ${finding.severity}]** ${finding.title}\n\n` +
    `${finding.explanation}\n\n` +
    `**Impact:** ${finding.impact}\n\n` +
    `**Recommendation:** ${finding.recommendation}`
  );
}

function renderSummary(
  confirmed: readonly Finding[],
  summaryOnly: readonly Finding[],
  outcomes: readonly AnalyzerOutcome[],
  marker: ReviewMarker,
): string {
  const lines = ["## Bicho PR Review", ""];
  lines.push(
    confirmed.length > 0
      ? `${confirmed.length} confirmed finding(s).`
      : "No confirmed issues found.",
  );
  if (summaryOnly.length > 0) {
    lines.push("", "### Findings not anchorable to the diff");
    for (const finding of summaryOnly) {
      lines.push(`- \`${finding.path}:${finding.startLine}\` — ${finding.title}`);
    }
  }
  const degraded = outcomes.filter(isDegraded);
  if (degraded.length > 0) {
    lines.push("", "### Analysis notes");
    for (const outcome of degraded) {
      for (const diagnostic of outcome.diagnostics) {
        lines.push(`- ${diagnostic.source}: ${diagnostic.status} — ${diagnostic.message}`);
      }
    }
  }
  lines.push("", renderMarker(marker));
  return lines.join("\n");
}

function modelIdOf(findings: readonly Finding[]): string {
  return findings.find((finding) => finding.modelId !== null)?.modelId ?? "none";
}

function runFingerprint(headSha: string): string {
  const payload = `${headSha}\x1f${WORKFLOW_VERSION}\x1f${PROMPT_VERSION}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);
}
