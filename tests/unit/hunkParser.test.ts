import { describe, expect, it } from "vitest";
import { DiffLineKind } from "../../src/domain/models/diff.ts";
import { DiffParser } from "../../src/infrastructure/diff/hunkParser.ts";

const parser = new DiffParser();

describe("DiffParser", () => {
  it("returns no hunks for an empty patch", () => {
    expect(parser.parseHunks("")).toEqual([]);
  });

  it("parses a hunk header's ranges", () => {
    const [hunk] = parser.parseHunks("@@ -10,3 +20,4 @@\n ctx");

    expect(hunk).toMatchObject({ oldStart: 10, oldCount: 3, newStart: 20, newCount: 4 });
  });

  it("defaults an omitted count to one", () => {
    const [hunk] = parser.parseHunks("@@ -5 +7 @@\n ctx");

    expect(hunk).toMatchObject({ oldStart: 5, oldCount: 1, newStart: 7, newCount: 1 });
  });

  it("captures the section heading", () => {
    const [hunk] = parser.parseHunks("@@ -1,1 +1,1 @@ export function main() {\n ctx");

    expect(hunk?.sectionHeading).toBe("export function main() {");
  });

  it("leaves the section heading empty when absent", () => {
    const [hunk] = parser.parseHunks("@@ -1,1 +1,1 @@\n ctx");

    expect(hunk?.sectionHeading).toBe("");
  });

  it("numbers added lines on the new side only", () => {
    const [hunk] = parser.parseHunks("@@ -1,0 +1,2 @@\n+first\n+second");

    expect(hunk?.lines).toEqual([
      { kind: DiffLineKind.ADDED, content: "first", oldLine: null, newLine: 1 },
      { kind: DiffLineKind.ADDED, content: "second", oldLine: null, newLine: 2 },
    ]);
  });

  it("numbers removed lines on the old side only", () => {
    const [hunk] = parser.parseHunks("@@ -1,2 +0,0 @@\n-first\n-second");

    expect(hunk?.lines).toEqual([
      { kind: DiffLineKind.REMOVED, content: "first", oldLine: 1, newLine: null },
      { kind: DiffLineKind.REMOVED, content: "second", oldLine: 2, newLine: null },
    ]);
  });

  it("numbers context lines on both sides and advances both counters", () => {
    const [hunk] = parser.parseHunks("@@ -10,2 +20,2 @@\n ctx-a\n ctx-b");

    expect(hunk?.lines).toEqual([
      { kind: DiffLineKind.CONTEXT, content: "ctx-a", oldLine: 10, newLine: 20 },
      { kind: DiffLineKind.CONTEXT, content: "ctx-b", oldLine: 11, newLine: 21 },
    ]);
  });

  it("tracks both counters independently across a mixed hunk", () => {
    const [hunk] = parser.parseHunks("@@ -10,2 +10,3 @@\n ctx\n-old\n+new_a\n+new_b");

    expect(hunk?.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      [DiffLineKind.CONTEXT, 10, 10],
      [DiffLineKind.REMOVED, 11, null],
      [DiffLineKind.ADDED, null, 11],
      [DiffLineKind.ADDED, null, 12],
    ]);
  });

  it("parses several hunks in one patch", () => {
    const patch = "@@ -1,1 +1,1 @@\n ctx\n@@ -50,1 +50,2 @@\n ctx\n+added";

    const hunks = parser.parseHunks(patch);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.newStart).toBe(1);
    expect(hunks[1]?.newStart).toBe(50);
    expect(hunks[1]?.lines).toHaveLength(2);
  });

  it('ignores the "\\ No newline at end of file" marker', () => {
    const [hunk] = parser.parseHunks("@@ -1,1 +1,1 @@\n+added\n\\ No newline at end of file");

    expect(hunk?.lines).toHaveLength(1);
  });

  it("ignores any preamble before the first hunk header", () => {
    const patch = "diff --git a/x.ts b/x.ts\nindex 111..222 100644\n@@ -1,1 +1,1 @@\n+added";

    const hunks = parser.parseHunks(patch);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toHaveLength(1);
  });

  it("returns no hunks when the patch has no header at all", () => {
    expect(parser.parseHunks("just some text\nmore text")).toEqual([]);
  });

  it("preserves an empty context line", () => {
    const [hunk] = parser.parseHunks("@@ -1,1 +1,1 @@\n ");

    expect(hunk?.lines[0]).toMatchObject({ kind: DiffLineKind.CONTEXT, content: "" });
  });
});
