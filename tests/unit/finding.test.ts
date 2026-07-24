import { describe, expect, it } from "vitest";
import {
  Confidence,
  isConfirmed,
  makeFinding,
  publishInline,
  publishInSummary,
  Severity,
  severityRank,
  VerificationState,
  withFinding,
} from "../../src/domain/models/finding.ts";
import { aFinding } from "../helpers/factories.ts";

describe("Finding", () => {
  it("applies defaults for the optional fields", () => {
    const finding = aFinding();

    expect(finding.diffSide).toBe("RIGHT");
    expect(finding.snippet).toBe("");
    expect(finding.evidence).toEqual([]);
    expect(finding.verificationState).toBe(VerificationState.CANDIDATE);
    expect(finding.verificationReason).toBeNull();
    expect(finding.canPublishInline).toBe(true);
    expect(finding.summaryOnly).toBe(false);
  });

  it("rejects an end line before the start line", () => {
    expect(() => aFinding({ startLine: 12, endLine: 10 })).toThrow(
      /endLine must be greater than or equal to startLine/,
    );
  });

  it("accepts an end line equal to the start line", () => {
    expect(aFinding({ startLine: 7, endLine: 7 }).endLine).toBe(7);
  });

  it("rejects a line number below one", () => {
    expect(() => aFinding({ startLine: 0, endLine: 3 })).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() => makeFinding({ ...aFinding(), severity: "catastrophic" as never })).toThrow();
  });

  it("orders severities from info to critical", () => {
    expect(severityRank[Severity.INFO]).toBeLessThan(severityRank[Severity.LOW]);
    expect(severityRank[Severity.LOW]).toBeLessThan(severityRank[Severity.MEDIUM]);
    expect(severityRank[Severity.MEDIUM]).toBeLessThan(severityRank[Severity.HIGH]);
    expect(severityRank[Severity.HIGH]).toBeLessThan(severityRank[Severity.CRITICAL]);
  });
});

describe("withFinding", () => {
  it("returns a copy with the update applied, leaving the original untouched", () => {
    const original = aFinding({ confidence: Confidence.LOW });

    const updated = withFinding(original, { confidence: Confidence.HIGH });

    expect(updated.confidence).toBe(Confidence.HIGH);
    expect(original.confidence).toBe(Confidence.LOW);
    expect(updated.id).toBe(original.id);
  });

  it("re-validates, so an update that breaks an invariant is rejected", () => {
    expect(() => withFinding(aFinding({ startLine: 5, endLine: 9 }), { endLine: 1 })).toThrow(
      /endLine must be greater than or equal to startLine/,
    );
  });
});

describe("publish gates", () => {
  it("treats only a confirmed finding as confirmed", () => {
    expect(isConfirmed(aFinding())).toBe(false);
    expect(isConfirmed(aFinding({ verificationState: VerificationState.CONFIRMED }))).toBe(true);
  });

  it("publishes a confirmed, anchorable, non-summary finding inline", () => {
    const finding = aFinding({ verificationState: VerificationState.CONFIRMED });

    expect(publishInline(finding)).toBe(true);
    expect(publishInSummary(finding)).toBe(false);
  });

  it("routes a confirmed finding that cannot be anchored to the summary", () => {
    const finding = aFinding({
      verificationState: VerificationState.CONFIRMED,
      canPublishInline: false,
    });

    expect(publishInline(finding)).toBe(false);
    expect(publishInSummary(finding)).toBe(true);
  });

  it("routes a confirmed summary-only finding to the summary even when anchorable", () => {
    const finding = aFinding({
      verificationState: VerificationState.CONFIRMED,
      summaryOnly: true,
    });

    expect(publishInline(finding)).toBe(false);
    expect(publishInSummary(finding)).toBe(true);
  });

  it("publishes an unconfirmed finding nowhere", () => {
    const finding = aFinding({
      verificationState: VerificationState.REJECTED,
      summaryOnly: true,
    });

    expect(publishInline(finding)).toBe(false);
    expect(publishInSummary(finding)).toBe(false);
  });
});
