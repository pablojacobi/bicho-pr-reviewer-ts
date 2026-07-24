import { describe, expect, it } from "vitest";
import {
  Confidence,
  Severity,
  SourceKind,
  VerificationState,
} from "../../src/domain/models/finding.ts";
import { deduplicate } from "../../src/domain/services/dedup.ts";
import { aFinding } from "../helpers/factories.ts";

describe("deduplicate", () => {
  it("leaves a lone finding untouched", () => {
    const finding = aFinding();

    expect(deduplicate([finding])).toEqual([finding]);
  });

  it("keeps findings with different fingerprints apart", () => {
    const a = aFinding({ id: "a", fingerprint: "fp-a" });
    const b = aFinding({ id: "b", fingerprint: "fp-b" });

    const result = deduplicate([a, b]);

    expect(result).toHaveLength(2);
    expect(result.every((f) => f.verificationState === VerificationState.CANDIDATE)).toBe(true);
  });

  it("keeps the highest-severity finding as the survivor", () => {
    const low = aFinding({ id: "a", severity: Severity.LOW });
    const high = aFinding({ id: "b", severity: Severity.CRITICAL });

    const [survivor, duplicate] = deduplicate([low, high]);

    expect(survivor?.id).toBe("b");
    expect(duplicate?.id).toBe("a");
    expect(duplicate?.verificationState).toBe(VerificationState.DUPLICATE);
    expect(duplicate?.verificationReason).toBe("merged into b");
  });

  it("breaks a severity tie by confidence", () => {
    const lower = aFinding({ id: "a", confidence: Confidence.MEDIUM });
    const higher = aFinding({ id: "b", confidence: Confidence.HIGH });

    expect(deduplicate([lower, higher])[0]?.id).toBe("b");
  });

  it("breaks a severity and confidence tie by source priority", () => {
    const llm = aFinding({ id: "a", sourceKind: SourceKind.LLM_ANALYZER });
    const semgrep = aFinding({ id: "b", sourceKind: SourceKind.SEMGREP });

    expect(deduplicate([llm, semgrep])[0]?.id).toBe("b");
  });

  it("breaks a full tie by the lowest id, so the result is order-independent", () => {
    const a = aFinding({ id: "a" });
    const b = aFinding({ id: "b" });

    expect(deduplicate([a, b])[0]?.id).toBe("a");
    expect(deduplicate([b, a])[0]?.id).toBe("a");
  });

  it("raises confidence when an independent source corroborates the finding", () => {
    const llm = aFinding({ id: "a", sourceKind: SourceKind.LLM_ANALYZER });
    const semgrep = aFinding({
      id: "b",
      sourceKind: SourceKind.SEMGREP,
      confidence: Confidence.MEDIUM,
    });

    expect(deduplicate([llm, semgrep])[0]?.confidence).toBe(Confidence.HIGH);
  });

  it("does not raise confidence when the duplicate comes from the same source kind", () => {
    const a = aFinding({ id: "a", sourceKind: SourceKind.LLM_ANALYZER });
    const b = aFinding({ id: "b", sourceKind: SourceKind.LLM_ANALYZER });

    expect(deduplicate([a, b])[0]?.confidence).toBe(Confidence.MEDIUM);
  });

  it("caps a raised confidence at high", () => {
    const a = aFinding({ id: "a", confidence: Confidence.HIGH, sourceKind: SourceKind.SEMGREP });
    const b = aFinding({
      id: "b",
      confidence: Confidence.HIGH,
      sourceKind: SourceKind.LLM_ANALYZER,
    });

    expect(deduplicate([a, b])[0]?.confidence).toBe(Confidence.HIGH);
  });

  it("keeps the group's highest severity, outranking a more confident but milder finding", () => {
    const high = aFinding({ id: "a", severity: Severity.HIGH, confidence: Confidence.HIGH });
    const critical = aFinding({
      id: "b",
      severity: Severity.CRITICAL,
      confidence: Confidence.LOW,
    });

    const [survivor] = deduplicate([high, critical]);

    expect(survivor?.id).toBe("b");
    expect(survivor?.severity).toBe(Severity.CRITICAL);
  });

  it("merges evidence from every finding in the group, without duplicates", () => {
    const shared = { path: "a.ts", startLine: 1, endLine: 2, detail: "shared" };
    const a = aFinding({ id: "a", evidence: [shared, { ...shared, detail: "only-a" }] });
    const b = aFinding({ id: "b", evidence: [shared, { ...shared, detail: "only-b" }] });

    const [survivor] = deduplicate([a, b]);

    expect(survivor?.evidence).toHaveLength(3);
    expect(survivor?.evidence.map((e) => e.detail).sort()).toEqual(["only-a", "only-b", "shared"]);
  });

  it("collapses findings that share both a fingerprint and an id", () => {
    // Ids are generated, so this should never happen; the comparator must still be total rather
    // than ordering inconsistently and dropping a finding.
    const first = aFinding({ id: "same", severity: Severity.HIGH, confidence: Confidence.HIGH });
    const second = aFinding({
      id: "same",
      severity: Severity.HIGH,
      confidence: Confidence.HIGH,
      sourceKind: SourceKind.LLM_ANALYZER,
    });

    const result = deduplicate([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("same");
  });
});
