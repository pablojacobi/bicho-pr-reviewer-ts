/**
 * Mapping findings to commentable diff locations.
 *
 * GitHub only accepts an inline comment on a line that is part of the diff: on the RIGHT side an
 * added or context line (it has a new-file number); on the LEFT side a removed or context line
 * (old-file number). These helpers answer "can this `(path, line-range, side)` be anchored?".
 */

import { type FileDiff, fileDiffFor, type NormalizedDiff } from "../models/diff.ts";
import { DiffSide } from "../models/finding.ts";

/** The set of file line numbers that can be commented on for the given `side`. */
export function commentableLines(fileDiff: FileDiff, side: DiffSide): Set<number> {
  const lines = new Set<number>();
  for (const hunk of fileDiff.hunks) {
    for (const line of hunk.lines) {
      const number = side === DiffSide.RIGHT ? line.newLine : line.oldLine;
      if (number !== null) {
        lines.add(number);
      }
    }
  }
  return lines;
}

/** Whether an inline comment can be anchored to `[startLine, endLine]` on `side`. */
export function canAnchor(
  diff: NormalizedDiff,
  location: { path: string; startLine: number; endLine: number; side: DiffSide },
): boolean {
  const fileDiff = fileDiffFor(diff, location.path);
  if (fileDiff === null) {
    return false;
  }
  const lines = commentableLines(fileDiff, location.side);
  return lines.has(location.startLine) && lines.has(location.endLine);
}
