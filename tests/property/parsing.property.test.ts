/**
 * Property-based tests for the parsing primitives.
 *
 * A diff parser must keep two line counters consistent over arbitrary line sequences, and a path
 * check must hold over arbitrary strings — the two places where hand-picked examples are least
 * trustworthy.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { UnsafePathError } from "../../src/domain/errors.ts";
import { DiffLineKind } from "../../src/domain/models/diff.ts";
import { DiffParser } from "../../src/infrastructure/diff/hunkParser.ts";
import { isSafeRelativePath, resolveWithin } from "../../src/infrastructure/fs/pathsafe.ts";

const parser = new DiffParser();

/** Diff body lines: an added, removed, or context line with arbitrary (newline-free) content. */
const bodyLine = fc
  .tuple(fc.constantFrom("+", "-", " "), fc.string({ unit: "grapheme-ascii" }))
  .map(([prefix, content]) => `${prefix}${content.replaceAll(/[\r\n]/g, "")}`);

describe("hunk parser properties", () => {
  it("never throws, whatever the patch text", () => {
    fc.assert(
      fc.property(fc.string(), (patch) => {
        expect(() => parser.parseHunks(patch)).not.toThrow();
      }),
    );
  });

  it("assigns every line at least one side's number", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.array(bodyLine, { minLength: 1, maxLength: 40 }),
        (oldStart, newStart, lines) => {
          const patch = [`@@ -${oldStart},1 +${newStart},1 @@`, ...lines].join("\n");

          for (const line of parser.parseHunks(patch).flatMap((hunk) => hunk.lines)) {
            expect(line.oldLine !== null || line.newLine !== null).toBe(true);
          }
        },
      ),
    );
  });

  it("numbers each side consecutively from the hunk's declared start", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.array(bodyLine, { minLength: 1, maxLength: 40 }),
        (oldStart, newStart, lines) => {
          const patch = [`@@ -${oldStart},1 +${newStart},1 @@`, ...lines].join("\n");
          const parsed = parser.parseHunks(patch).flatMap((hunk) => hunk.lines);

          const oldNumbers = parsed.map((l) => l.oldLine).filter((n) => n !== null);
          const newNumbers = parsed.map((l) => l.newLine).filter((n) => n !== null);

          expect(oldNumbers).toEqual(oldNumbers.map((_, index) => oldStart + index));
          expect(newNumbers).toEqual(newNumbers.map((_, index) => newStart + index));
        },
      ),
    );
  });

  it("preserves each line's content verbatim after its one-character prefix", () => {
    fc.assert(
      fc.property(fc.array(bodyLine, { minLength: 1, maxLength: 20 }), (lines) => {
        const parsed = parser.parseHunks(["@@ -1,1 +1,1 @@", ...lines].join("\n"));

        expect(parsed.flatMap((h) => h.lines).map((l) => l.content)).toEqual(
          lines.map((line) => line.slice(1)),
        );
      }),
    );
  });

  it("classifies each line by its prefix", () => {
    fc.assert(
      fc.property(fc.array(bodyLine, { minLength: 1, maxLength: 20 }), (lines) => {
        const expected = lines.map((line) =>
          line.startsWith("+")
            ? DiffLineKind.ADDED
            : line.startsWith("-")
              ? DiffLineKind.REMOVED
              : DiffLineKind.CONTEXT,
        );
        const parsed = parser.parseHunks(["@@ -1,1 +1,1 @@", ...lines].join("\n"));

        expect(parsed.flatMap((h) => h.lines).map((l) => l.kind)).toEqual(expected);
      }),
    );
  });
});

describe("path safety properties", () => {
  it("never accepts a path containing a traversal segment", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "grapheme-ascii" }), { maxLength: 6 }), (parts) => {
        const path = [...parts, ".."].join("/");

        expect(isSafeRelativePath(path)).toBe(false);
      }),
    );
  });

  it("never accepts an absolute path", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-ascii" }), (rest) => {
        expect(isSafeRelativePath(`/${rest}`)).toBe(false);
      }),
    );
  });

  it("either resolves strictly inside the base or rejects outright", () => {
    // The load-bearing invariant: nothing this function returns can ever point outside the
    // sandbox, whatever the repository called the file.
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        let resolved: string;
        try {
          resolved = resolveWithin("/tmp/base", candidate);
        } catch (error) {
          expect(error).toBeInstanceOf(UnsafePathError);
          return;
        }
        expect(resolved === "/tmp/base" || resolved.startsWith("/tmp/base/")).toBe(true);
      }),
    );
  });

  it("always rejects a path a caller pre-screened as unsafe for traversal", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "grapheme-ascii" }), { maxLength: 4 }), (parts) => {
        const escaping = ["..", "..", ...parts].join("/");

        expect(isSafeRelativePath(escaping)).toBe(false);
        expect(() => resolveWithin("/tmp/base", escaping)).toThrow(UnsafePathError);
      }),
    );
  });
});
