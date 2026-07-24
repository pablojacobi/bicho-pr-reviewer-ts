/**
 * Set each finding's inline-anchor flag against the diff.
 *
 * A confirmed finding that cannot be anchored to a commentable diff line is not dropped — it is
 * routed to the review summary instead (see `publishInSummary`). This service only decides, per
 * finding, whether an inline anchor is possible.
 */

import type { NormalizedDiff } from "../models/diff.ts";
import { type Finding, withFinding } from "../models/finding.ts";
import { canAnchor } from "./diffMapping.ts";

/** Return the findings with `canPublishInline` set to whether each anchors to the diff. */
export function anchorFindings(
  findings: readonly Finding[],
  diff: NormalizedDiff,
): readonly Finding[] {
  return findings.map((finding) => {
    const anchorable = canAnchor(diff, {
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      side: finding.diffSide,
    });
    return finding.canPublishInline === anchorable
      ? finding
      : withFinding(finding, { canPublishInline: anchorable });
  });
}
