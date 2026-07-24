/**
 * Normalized diff model.
 *
 * A `NormalizedDiff` is what anchoring works against: per-file hunks whose every line carries its
 * old-file and/or new-file line number, so we can decide whether a given `(path, line, side)` is
 * commentable on the PR. It is produced from GitHub's per-file `patch` hunks by the diff parser.
 */

/** How a file changed in the PR. */
export const FileChangeKind = {
  ADDED: "added",
  MODIFIED: "modified",
  REMOVED: "removed",
  RENAMED: "renamed",
} as const;
export type FileChangeKind = (typeof FileChangeKind)[keyof typeof FileChangeKind];

/** The role of a single line within a hunk. */
export const DiffLineKind = {
  CONTEXT: "context",
  ADDED: "added",
  REMOVED: "removed",
} as const;
export type DiffLineKind = (typeof DiffLineKind)[keyof typeof DiffLineKind];

/** One line of a hunk, with its old- and/or new-file line number. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

/** A single `@@` hunk. */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly sectionHeading: string;
  readonly lines: readonly DiffLine[];
}

/** The change to a single file, with its parsed hunks. */
export interface FileDiff {
  readonly path: string;
  readonly changeKind: FileChangeKind;
  readonly previousPath: string | null;
  readonly isBinary: boolean;
  readonly hunks: readonly DiffHunk[];
}

/** The full set of file changes in a PR. */
export interface NormalizedDiff {
  readonly files: readonly FileDiff[];
}

/** Return the {@link FileDiff} for `path`, or `null` if the path is not in the diff. */
export function fileDiffFor(diff: NormalizedDiff, path: string): FileDiff | null {
  return diff.files.find((file) => file.path === path) ?? null;
}
