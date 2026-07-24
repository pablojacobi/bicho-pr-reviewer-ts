import { describe, expect, it } from "vitest";
import { resilientOutcome } from "../../src/application/graph/resilience.ts";
import { type ReviewStateUpdate, required } from "../../src/application/graph/state.ts";
import {
  type AnalyzerOutcome,
  makeOutcome,
  OutcomeStatus,
} from "../../src/domain/models/analysis.ts";
import { aFinding } from "../helpers/factories.ts";

/**
 * `ReviewStateUpdate#outcomes` is typed to also allow LangGraph's `OverwriteValue` escape hatch,
 * which `resilientOutcome` never uses. Narrow it back down to a plain array for assertions.
 */
function outcomesOf(update: ReviewStateUpdate): readonly AnalyzerOutcome[] {
  const { outcomes } = update;
  if (!Array.isArray(outcomes)) {
    throw new Error("expected `outcomes` to be a plain array");
  }
  return outcomes;
}

describe("resilientOutcome", () => {
  it("passes a successful outcome straight through", async () => {
    const outcome: AnalyzerOutcome = makeOutcome({
      source: "security",
      status: OutcomeStatus.OK,
      findings: [aFinding()],
    });

    const update = await resilientOutcome("security", async () => outcome);

    expect(update).toEqual({ outcomes: [outcome] });
  });

  it("converts a thrown Error into an ERROR outcome carrying the error's message", async () => {
    const update = await resilientOutcome("security", async () => {
      throw new Error("model exploded");
    });

    expect(outcomesOf(update)).toEqual([
      {
        source: "security",
        status: OutcomeStatus.ERROR,
        findings: [],
        diagnostics: [
          { source: "security", status: OutcomeStatus.ERROR, message: "model exploded" },
        ],
      },
    ]);
  });

  it.each([
    ["a thrown string", "boom", "boom"],
    ["a thrown number", 42, "42"],
  ])("converts %s into a diagnostic carrying its string form", async (_case, thrown, expected) => {
    const update = await resilientOutcome("security", async () => {
      throw thrown;
    });

    const [outcome] = outcomesOf(update);
    expect(outcome?.diagnostics[0]?.message).toBe(expected);
    expect(outcome?.status).toBe(OutcomeStatus.ERROR);
  });

  it("names the outcome's source after the node that failed", async () => {
    const update = await resilientOutcome("performance", async () => {
      throw new Error("boom");
    });

    expect(outcomesOf(update)[0]?.source).toBe("performance");
  });
});

describe("required", () => {
  it("returns a non-null value unchanged", () => {
    expect(required("value", "field")).toBe("value");
    expect(required({ a: 1 }, "field")).toEqual({ a: 1 });
  });

  it.each([0, ""])("returns a falsy-but-non-null value (%j) unchanged", (value) => {
    expect(required(value, "field")).toBe(value);
  });

  it("throws a message naming the field when given null", () => {
    expect(() => required(null, "pullRequest")).toThrow(
      "graph invariant violated: pullRequest was not populated by an earlier node",
    );
  });
});
