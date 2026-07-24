/**
 * Property-based tests for the domain's identity primitives.
 *
 * A fingerprint must stay stable under exactly the transformations it claims to absorb, and a
 * review marker must survive a round trip through whatever prose surrounds it — both are what let
 * a re-run recognise work it has already done.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseMarker, renderMarker } from "../../src/domain/models/marker.ts";
import { computeFingerprint } from "../../src/domain/services/fingerprint.ts";

describe("fingerprint properties", () => {
  const parts = fc.record({
    path: fc.string({ unit: "grapheme-ascii" }),
    category: fc.string({ unit: "grapheme-ascii" }),
    subcategory: fc.string({ unit: "grapheme-ascii" }),
    ruleKey: fc.string({ unit: "grapheme-ascii" }),
    enclosingSymbol: fc.option(fc.string({ unit: "grapheme-ascii" }), { nil: null }),
    snippet: fc.string(),
  });

  it("is always 16 lowercase hex characters", () => {
    fc.assert(
      fc.property(parts, (input) => {
        expect(computeFingerprint(input)).toMatch(/^[0-9a-f]{16}$/);
      }),
    );
  });

  it("is deterministic for identical input", () => {
    fc.assert(
      fc.property(parts, (input) => {
        expect(computeFingerprint(input)).toBe(computeFingerprint(input));
      }),
    );
  });

  it("absorbs whitespace reflowing in the snippet", () => {
    fc.assert(
      fc.property(parts, fc.string({ unit: fc.constantFrom(" ", "\t", "\n") }), (input, gap) => {
        const reflowed = {
          ...input,
          snippet: `  ${input.snippet.replaceAll(/\s+/g, gap || " ")} `,
        };

        // Only meaningful when the snippet has no internal whitespace runs to collapse differently.
        fc.pre(input.snippet.trim().replaceAll(/\s+/g, " ") === reflowed.snippet.trim());
        expect(computeFingerprint(reflowed)).toBe(computeFingerprint(input));
      }),
    );
  });

  it("ignores a leading ./ on the path", () => {
    fc.assert(
      fc.property(parts, (input) => {
        const prefixed = { ...input, path: `./${input.path.trim()}` };
        const plain = { ...input, path: input.path.trim() };

        expect(computeFingerprint(prefixed)).toBe(computeFingerprint(plain));
      }),
    );
  });

  it("separates components so their contents cannot forge a boundary", () => {
    // Moving a character across a component boundary must change the identity.
    expect(
      computeFingerprint({
        path: "ab",
        category: "c",
        subcategory: "",
        ruleKey: "",
        enclosingSymbol: null,
        snippet: "",
      }),
    ).not.toBe(
      computeFingerprint({
        path: "a",
        category: "bc",
        subcategory: "",
        ruleKey: "",
        enclosingSymbol: null,
        snippet: "",
      }),
    );
  });
});

describe("review marker properties", () => {
  // Marker fields are rendered space-separated and parsed with `\S*`, so they must be non-empty and
  // whitespace-free — which is what the real values (SHAs, versions, digests) always are.
  const field = fc
    .string({ unit: "grapheme-ascii", minLength: 1 })
    .map((value) => value.replaceAll(/[\s>]/g, "_"))
    .filter((value) => value.length > 0);

  it("round-trips any whitespace-free field values", () => {
    fc.assert(
      fc.property(
        fc.record({
          headSha: field,
          workflowVersion: field,
          runFingerprint: field,
          modelId: field,
          promptVersion: field,
        }),
        (marker) => {
          expect(parseMarker(renderMarker(marker))).toEqual(marker);
        },
      ),
    );
  });

  it("finds the marker regardless of surrounding review prose", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const marker = {
          headSha: "sha",
          workflowVersion: "1",
          runFingerprint: "fp",
          modelId: "m",
          promptVersion: "v1",
        };
        // Prose must not itself contain a marker opener that would match first.
        fc.pre(!before.includes("<!--"));

        expect(parseMarker(`${before}\n${renderMarker(marker)}\n${after}`)).toEqual(marker);
      }),
    );
  });
});
