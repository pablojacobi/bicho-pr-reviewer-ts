/** Port for parsing unified-diff hunks into the domain model. */

import type { DiffHunk } from "../models/diff.ts";

/** Parses a single file's unified-diff `patch` (a sequence of `@@` hunks) into hunks. */
export interface DiffParserPort {
  parseHunks(patch: string): readonly DiffHunk[];
}
