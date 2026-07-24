/**
 * A small, dependency-free unified-diff hunk parser.
 *
 * This deliberately avoids a third-party diff library: it parses the per-file `patch` text GitHub
 * returns from the "list pull request files" endpoint into {@link DiffHunk} objects, tracking each
 * line's old- and new-file number so inline comments can be anchored precisely.
 */

import { type DiffHunk, type DiffLine, DiffLineKind } from "../../domain/models/diff.ts";
import type { DiffParserPort } from "../../domain/ports/diffParser.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/;

interface HunkHeader {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly sectionHeading: string;
}

/** Parses unified-diff hunks (the {@link DiffParserPort} implementation). */
export class DiffParser implements DiffParserPort {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a unified-diff parser is a state machine over line prefixes, and each branch advances the old/new counters it belongs to — splitting them apart would scatter the very invariant this function exists to hold.
  parseHunks(patch: string): readonly DiffHunk[] {
    const hunks: DiffHunk[] = [];
    let header: HunkHeader | null = null;
    let lines: DiffLine[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.split("\n")) {
      const match = HUNK_HEADER.exec(raw);
      if (match !== null) {
        if (header !== null) {
          hunks.push({ ...header, lines });
        }
        header = toHeader(match);
        oldLine = header.oldStart;
        newLine = header.newStart;
        lines = [];
        continue;
      }
      if (header === null) {
        continue; // defensive: any preamble before the first hunk is ignored
      }
      if (raw.startsWith("\\")) {
        continue; // "\ No newline at end of file"
      }
      if (raw.startsWith("+")) {
        lines.push({
          kind: DiffLineKind.ADDED,
          content: raw.slice(1),
          oldLine: null,
          newLine,
        });
        newLine += 1;
      } else if (raw.startsWith("-")) {
        lines.push({
          kind: DiffLineKind.REMOVED,
          content: raw.slice(1),
          oldLine,
          newLine: null,
        });
        oldLine += 1;
      } else {
        lines.push({
          kind: DiffLineKind.CONTEXT,
          content: raw.slice(1),
          oldLine,
          newLine,
        });
        oldLine += 1;
        newLine += 1;
      }
    }

    if (header !== null) {
      hunks.push({ ...header, lines });
    }
    return hunks;
  }
}

function toHeader(match: RegExpExecArray): HunkHeader {
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    sectionHeading: match[5] ?? "",
  };
}
