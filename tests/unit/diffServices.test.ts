import { describe, expect, it } from "vitest";
import { fileDiffFor, type NormalizedDiff } from "../../src/domain/models/diff.ts";
import { DiffSide, Severity, VerificationState } from "../../src/domain/models/finding.ts";
import { ReviewEvent } from "../../src/domain/models/review.ts";
import { canAnchor, commentableLines } from "../../src/domain/services/diffMapping.ts";
import { anchorFindings } from "../../src/domain/services/locations.ts";
import { reviewEvent } from "../../src/domain/services/severityPolicy.ts";
import { verifyByPolicy } from "../../src/domain/services/verificationPolicy.ts";
import { aDiff, aFinding } from "../helpers/factories.ts";

const emptyDiff: NormalizedDiff = { files: [] };

describe("fileDiffFor", () => {
  it("finds a file present in the diff", () => {
    expect(fileDiffFor(aDiff(), "app/db.ts")?.path).toBe("app/db.ts");
  });

  it("returns null for a file absent from the diff", () => {
    expect(fileDiffFor(aDiff(), "app/other.ts")).toBeNull();
  });
});

describe("commentableLines", () => {
  it("collects new-file numbers for the right side", () => {
    const file = fileDiffFor(aDiff(), "app/db.ts") as NonNullable<ReturnType<typeof fileDiffFor>>;

    expect([...commentableLines(file, DiffSide.RIGHT)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it("collects old-file numbers for the left side", () => {
    const file = fileDiffFor(aDiff(), "app/db.ts") as NonNullable<ReturnType<typeof fileDiffFor>>;

    expect([...commentableLines(file, DiffSide.LEFT)].sort((a, b) => a - b)).toEqual([10, 11]);
  });
});

describe("canAnchor", () => {
  it("anchors a range fully inside the commentable right-side lines", () => {
    expect(
      canAnchor(aDiff(), {
        path: "app/db.ts",
        startLine: 10,
        endLine: 12,
        side: DiffSide.RIGHT,
      }),
    ).toBe(true);
  });

  it("refuses a range whose end is outside the diff", () => {
    expect(
      canAnchor(aDiff(), {
        path: "app/db.ts",
        startLine: 10,
        endLine: 99,
        side: DiffSide.RIGHT,
      }),
    ).toBe(false);
  });

  it("refuses a range whose start is outside the diff", () => {
    expect(
      canAnchor(aDiff(), { path: "app/db.ts", startLine: 1, endLine: 12, side: DiffSide.RIGHT }),
    ).toBe(false);
  });

  it("refuses a right-side-only line on the left side", () => {
    expect(
      canAnchor(aDiff(), { path: "app/db.ts", startLine: 12, endLine: 12, side: DiffSide.LEFT }),
    ).toBe(false);
  });

  it("refuses a file that is not in the diff at all", () => {
    expect(
      canAnchor(emptyDiff, { path: "app/db.ts", startLine: 10, endLine: 10, side: DiffSide.RIGHT }),
    ).toBe(false);
  });
});

describe("anchorFindings", () => {
  it("keeps canPublishInline true for an anchorable finding, returning it unchanged", () => {
    const finding = aFinding({ startLine: 10, endLine: 12 });

    const [anchored] = anchorFindings([finding], aDiff());

    expect(anchored?.canPublishInline).toBe(true);
    expect(anchored).toBe(finding);
  });

  it("clears canPublishInline for a finding that cannot be anchored", () => {
    const [anchored] = anchorFindings([aFinding({ startLine: 90, endLine: 95 })], aDiff());

    expect(anchored?.canPublishInline).toBe(false);
  });

  it("restores canPublishInline when a previously unanchorable finding does anchor", () => {
    const finding = aFinding({ startLine: 10, endLine: 12, canPublishInline: false });

    const [anchored] = anchorFindings([finding], aDiff());

    expect(anchored?.canPublishInline).toBe(true);
  });
});

describe("reviewEvent", () => {
  it("requests changes when a finding is high severity", () => {
    expect(reviewEvent([aFinding({ severity: Severity.HIGH })])).toBe(ReviewEvent.REQUEST_CHANGES);
  });

  it("requests changes when a finding is critical", () => {
    expect(reviewEvent([aFinding({ severity: Severity.CRITICAL })])).toBe(
      ReviewEvent.REQUEST_CHANGES,
    );
  });

  it("comments when every finding is below high severity", () => {
    expect(reviewEvent([aFinding({ severity: Severity.MEDIUM })])).toBe(ReviewEvent.COMMENT);
  });

  it("comments when there are no findings at all", () => {
    expect(reviewEvent([])).toBe(ReviewEvent.COMMENT);
  });
});

describe("verifyByPolicy", () => {
  it("confirms a candidate above the confidence threshold", () => {
    const verified = verifyByPolicy(aFinding({ confidence: "medium" }));

    expect(verified.verificationState).toBe(VerificationState.CONFIRMED);
    expect(verified.verificationReason).toBe("confirmed by the first-pass policy");
  });

  it("rejects a low-confidence candidate", () => {
    const verified = verifyByPolicy(aFinding({ confidence: "low" }));

    expect(verified.verificationState).toBe(VerificationState.REJECTED);
    expect(verified.verificationReason).toMatch(/below threshold/);
  });

  it("never promotes a finding an earlier pass already resolved", () => {
    const duplicate = aFinding({ verificationState: VerificationState.DUPLICATE });

    expect(verifyByPolicy(duplicate)).toBe(duplicate);
  });
});
