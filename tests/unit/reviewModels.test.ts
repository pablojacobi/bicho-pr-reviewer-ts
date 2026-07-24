/**
 * The domain's review-side value objects.
 *
 * These carry the construction defaults and invariants the rest of the system relies on without
 * restating them: an inline comment's side and range, a review's options, an analyzer outcome's
 * empty collections, and a model call's tracing metadata.
 */

import { describe, expect, it } from "vitest";
import { isDegraded, makeOutcome, OutcomeStatus } from "../../src/domain/models/analysis.ts";
import {
  isMultiline,
  makeInlineComment,
  makeReviewOptions,
} from "../../src/domain/models/review.ts";
import { errorResult, makeRunMeta, okResult } from "../../src/domain/ports/modelProvider.ts";

describe("InlineComment", () => {
  it("is single-line when it has no start line", () => {
    expect(isMultiline(makeInlineComment({ path: "a.ts", line: 5, body: "b" }))).toBe(false);
  });

  it("is multi-line when it spans a range", () => {
    const comment = makeInlineComment({ path: "a.ts", line: 9, body: "b", startLine: 5 });

    expect(isMultiline(comment)).toBe(true);
  });

  it("defaults to the right-hand side of the diff", () => {
    expect(makeInlineComment({ path: "a.ts", line: 5, body: "b" }).side).toBe("RIGHT");
  });

  it("rejects a start line after the line it anchors to", () => {
    expect(() => makeInlineComment({ path: "a.ts", line: 5, body: "b", startLine: 9 })).toThrow(
      /startLine must be less than or equal to line/,
    );
  });

  it("accepts a start line equal to the line", () => {
    expect(makeInlineComment({ path: "a.ts", line: 5, body: "b", startLine: 5 }).startLine).toBe(5);
  });
});

describe("makeReviewOptions", () => {
  it("defaults to the webhook path's behaviour", () => {
    expect(makeReviewOptions()).toEqual({
      dryRun: false,
      force: false,
      focus: null,
      categories: [],
    });
  });

  it("keeps every field it is given", () => {
    expect(
      makeReviewOptions({ dryRun: true, force: true, focus: "auth", categories: ["tests"] }),
    ).toEqual({ dryRun: true, force: true, focus: "auth", categories: ["tests"] });
  });
});

describe("makeOutcome", () => {
  it("defaults both collections to empty", () => {
    const outcome = makeOutcome({ source: "semgrep", status: OutcomeStatus.ZERO_FINDINGS });

    expect(outcome.findings).toEqual([]);
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("makeRunMeta", () => {
  it("defaults the tag list to empty", () => {
    const meta = makeRunMeta({ role: "security", promptVersion: "v1", correlationId: "c" });

    expect(meta.tags).toEqual([]);
  });
});

describe("isDegraded", () => {
  it.each([OutcomeStatus.ERROR, OutcomeStatus.TIMEOUT, OutcomeStatus.SKIPPED])(
    "treats %s as degraded, so the reader is told the analysis was incomplete",
    (status) => {
      expect(isDegraded(makeOutcome({ source: "semgrep", status }))).toBe(true);
    },
  );

  it.each([OutcomeStatus.OK, OutcomeStatus.ZERO_FINDINGS])(
    "treats %s as a healthy run",
    (status) => {
      expect(isDegraded(makeOutcome({ source: "semgrep", status }))).toBe(false);
    },
  );
});

describe("model results", () => {
  it("carries the validated value on success", () => {
    const result = okResult({ findings: [] }, "minimax-m3", "raw text");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ findings: [] });
    expect(result.modelId).toBe("minimax-m3");
    expect(result.raw).toBe("raw text");
  });

  it("carries the reason on failure, without a value to mistake for one", () => {
    const result = errorResult("upstream 503", "minimax-m3");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("upstream 503");
    expect(result.raw).toBeNull();
  });

  it("defaults the raw text to null on both paths", () => {
    expect(okResult(1, "m").raw).toBeNull();
    expect(errorResult("x", "m").raw).toBeNull();
  });
});
