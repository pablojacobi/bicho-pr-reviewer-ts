/** Decide the GitHub review event from the confirmed findings. */

import { type Finding, Severity } from "../models/finding.ts";
import { ReviewEvent } from "../models/review.ts";

const REQUEST_CHANGES_AT: ReadonlySet<Severity> = new Set([Severity.HIGH, Severity.CRITICAL]);

/** REQUEST_CHANGES if any finding is high/critical, otherwise a plain COMMENT. */
export function reviewEvent(findings: readonly Finding[]): ReviewEvent {
  return findings.some((finding) => REQUEST_CHANGES_AT.has(finding.severity))
    ? ReviewEvent.REQUEST_CHANGES
    : ReviewEvent.COMMENT;
}
