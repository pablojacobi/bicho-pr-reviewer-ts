import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../../src/application/analyzers/schemas.ts";
import { getPrompt } from "../../src/application/prompts/registry.ts";
import { LLMFindingVerifier, PolicyVerifier } from "../../src/application/verifier.ts";
import { VerificationState } from "../../src/domain/models/finding.ts";
import { errorResult, okResult } from "../../src/domain/ports/modelProvider.ts";
import { FakeModelProvider } from "../../src/infrastructure/model/fake.ts";
import { aDiff, aFinding } from "../helpers/factories.ts";

const diff = aDiff();
const correlationId = "corr-1";

describe("PolicyVerifier", () => {
  it("applies the deterministic policy to each finding", async () => {
    const high = aFinding({ id: "a", confidence: "high" });
    const low = aFinding({ id: "b", confidence: "low" });

    const result = await new PolicyVerifier().verify([high, low]);

    expect(result[0]?.verificationState).toBe(VerificationState.CONFIRMED);
    expect(result[1]?.verificationState).toBe(VerificationState.REJECTED);
  });
});

describe("LLMFindingVerifier", () => {
  it("returns findings unchanged, without calling the model, when there are no CANDIDATE findings", async () => {
    const model = new FakeModelProvider([]);
    const verifier = new LLMFindingVerifier({ model });
    const findings = [
      aFinding({ id: "a", verificationState: VerificationState.DUPLICATE }),
      aFinding({ id: "b", verificationState: VerificationState.CONFIRMED }),
    ];

    const result = await verifier.verify(findings, { diff, correlationId });

    expect(result).toEqual(findings);
    expect(model.calls).toEqual([]);
  });

  it.each([
    [true, "clearly a real bug", VerificationState.CONFIRMED, "clearly a real bug"],
    [true, "", VerificationState.CONFIRMED, "confirmed by the verifier"],
    [
      false,
      "not introduced by this diff",
      VerificationState.REJECTED,
      "not introduced by this diff",
    ],
    [false, "", VerificationState.REJECTED, "rejected by the verifier"],
  ])(
    "applies keep=%s with reason %j as state %s and reason %j",
    async (keep, reason, expectedState, expectedReason) => {
      const model = new FakeModelProvider([
        okResult<VerificationReport>({ verdicts: [{ index: 0, keep, reason }] }, "m"),
      ]);
      const verifier = new LLMFindingVerifier({ model });

      const [result] = await verifier.verify([aFinding({ id: "a" })], { diff, correlationId });

      expect(result?.verificationState).toBe(expectedState);
      expect(result?.verificationReason).toBe(expectedReason);
    },
  );

  it("falls back to the deterministic policy for a candidate given no verdict, leaving others untouched", async () => {
    const model = new FakeModelProvider([okResult<VerificationReport>({ verdicts: [] }, "m")]);
    const verifier = new LLMFindingVerifier({ model });
    const duplicate = aFinding({ id: "dup", verificationState: VerificationState.DUPLICATE });
    const highConfidence = aFinding({ id: "a", confidence: "high" });

    const [first, second] = await verifier.verify([duplicate, highConfidence], {
      diff,
      correlationId,
    });

    expect(first).toBe(duplicate);
    expect(second?.verificationState).toBe(VerificationState.CONFIRMED);
    expect(second?.verificationReason).toBe("confirmed by the first-pass policy");
  });

  it("falls back to the policy for every candidate when the model call fails, leaving others untouched", async () => {
    const model = new FakeModelProvider([errorResult("timeout", "m")]);
    const verifier = new LLMFindingVerifier({ model });
    const duplicate = aFinding({ id: "dup", verificationState: VerificationState.DUPLICATE });
    const findings = [
      duplicate,
      aFinding({ id: "a", confidence: "high" }),
      aFinding({ id: "b", confidence: "low" }),
    ];

    const result = await verifier.verify(findings, { diff, correlationId });

    expect(result[0]).toBe(duplicate);
    expect(result[1]?.verificationState).toBe(VerificationState.CONFIRMED);
    expect(result[2]?.verificationState).toBe(VerificationState.REJECTED);
  });

  it("indexes verdicts against the full findings list, not the filtered candidate list", async () => {
    const duplicate = aFinding({ id: "dup", verificationState: VerificationState.DUPLICATE });
    const candidate = aFinding({ id: "cand", confidence: "high" });
    // Only one finding (at index 1) is a CANDIDATE, but the verdict is addressed to index 1 of the
    // *full* list, where the DUPLICATE sits at index 0. A filtered-index bug would look for this
    // verdict at position 0 of the candidates-only array and never find it.
    const model = new FakeModelProvider([
      okResult<VerificationReport>(
        { verdicts: [{ index: 1, keep: false, reason: "false positive" }] },
        "m",
      ),
    ]);
    const verifier = new LLMFindingVerifier({ model });

    const [first, second] = await verifier.verify([duplicate, candidate], { diff, correlationId });

    expect(first).toBe(duplicate);
    expect(second?.id).toBe("cand");
    expect(second?.verificationState).toBe(VerificationState.REJECTED);
    expect(second?.verificationReason).toBe("false positive");
  });

  it("renders a prompt with the verifier template, the diff, and one bracketed index line per candidate", async () => {
    const model = new FakeModelProvider([okResult<VerificationReport>({ verdicts: [] }, "m")]);
    const verifier = new LLMFindingVerifier({ model });
    const duplicate = aFinding({ id: "dup", verificationState: VerificationState.DUPLICATE });
    const candidateA = aFinding({ id: "a", path: "app/db.ts", startLine: 10, title: "Issue A" });
    const candidateB = aFinding({ id: "b", path: "app/db.ts", startLine: 11, title: "Issue B" });

    await verifier.verify([duplicate, candidateA, candidateB], { diff, correlationId });

    const prompt = model.calls[0]?.prompt ?? "";
    expect(prompt).toContain(getPrompt("verifier"));
    expect(prompt).toContain("## Diff");

    const bracketedLines = prompt.split("\n").filter((line) => /^\[\d+]/.test(line));
    expect(bracketedLines).toHaveLength(2);
    expect(bracketedLines[0]).toContain("[1]");
    expect(bracketedLines[0]).toContain("Issue A");
    expect(bracketedLines[1]).toContain("[2]");
    expect(bracketedLines[1]).toContain("Issue B");
  });
});
