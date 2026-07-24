/** Shared test factories — small, explicit builders instead of fixtures. */

import { DiffLineKind, FileChangeKind, type NormalizedDiff } from "../../src/domain/models/diff.ts";
import {
  Category,
  Confidence,
  type Finding,
  type FindingInput,
  makeFinding,
  Severity,
  SourceKind,
} from "../../src/domain/models/finding.ts";
import type { ChangedFile, PullRequest } from "../../src/domain/models/pullRequest.ts";

/** Build a valid {@link Finding}, overriding any fields you pass. */
export function aFinding(overrides: Partial<FindingInput> = {}): Finding {
  return makeFinding({
    id: "f1",
    fingerprint: "fp0000000000000a",
    category: Category.SECURITY,
    subcategory: "sql-injection",
    severity: Severity.HIGH,
    confidence: Confidence.MEDIUM,
    title: "Title",
    explanation: "Explanation.",
    impact: "Impact.",
    recommendation: "Recommendation.",
    path: "app/db.ts",
    startLine: 10,
    endLine: 12,
    sourceKind: SourceKind.LLM_ANALYZER,
    sourceName: "security",
    headSha: "sha",
    language: "typescript",
    ...overrides,
  });
}

/**
 * A small diff for `app/db.ts`.
 *
 * Commentable RIGHT lines are {10, 11, 12}; commentable LEFT lines are {10, 11}.
 */
export function aDiff(): NormalizedDiff {
  return {
    files: [
      {
        path: "app/db.ts",
        changeKind: FileChangeKind.MODIFIED,
        previousPath: null,
        isBinary: false,
        hunks: [
          {
            oldStart: 10,
            oldCount: 2,
            newStart: 10,
            newCount: 3,
            sectionHeading: "",
            lines: [
              { kind: DiffLineKind.CONTEXT, content: "ctx", oldLine: 10, newLine: 10 },
              { kind: DiffLineKind.REMOVED, content: "old", oldLine: 11, newLine: null },
              { kind: DiffLineKind.ADDED, content: "new_a", oldLine: null, newLine: 11 },
              { kind: DiffLineKind.ADDED, content: "new_b", oldLine: null, newLine: 12 },
            ],
          },
        ],
      },
    ],
  };
}

/** Build a {@link PullRequest}, overriding any fields you pass. */
export function aPullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: "octo/hello-world",
    number: 42,
    headSha: "headsha",
    baseRef: "main",
    title: "Add a thing",
    body: "",
    isDraft: false,
    author: "octocat",
    installationId: 7,
    ...overrides,
  };
}

/** Build a {@link ChangedFile}, overriding any fields you pass. */
export function aChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: "app/db.ts",
    status: "modified",
    patch: "@@ -10,2 +10,3 @@\n ctx\n-old\n+new_a\n+new_b",
    previousFilename: null,
    additions: 2,
    deletions: 1,
    ...overrides,
  };
}
