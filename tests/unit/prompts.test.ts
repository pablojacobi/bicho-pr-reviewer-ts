import { describe, expect, it } from "vitest";
import { getPrompt, PROMPT_VERSION } from "../../src/application/prompts/registry.ts";

/** The six roles that share the analyzer prompt shape (as opposed to the verifier). */
const ANALYZER_ROLES = [
  "correctness",
  "security",
  "performance",
  "maintainability",
  "tests",
  "contracts",
] as const;

describe("getPrompt", () => {
  it.each([...ANALYZER_ROLES, "verifier"])("returns a non-empty template for role %s", (role) => {
    const template = getPrompt(role);

    expect(typeof template).toBe("string");
    expect(template.length).toBeGreaterThan(0);
  });

  it.each(ANALYZER_ROLES)(
    "includes the shared untrusted-data rule in the %s analyzer template",
    (role) => {
      expect(getPrompt(role)).toContain("untrusted data");
    },
  );

  it("includes an untrusted-data instruction in the verifier template too", () => {
    expect(getPrompt("verifier")).toContain("untrusted data");
  });

  it("throws for an unknown role", () => {
    expect(() => getPrompt("no-such-role")).toThrow(/no prompt registered for role "no-such-role"/);
  });
});

describe("PROMPT_VERSION", () => {
  it("is exported as a non-empty string", () => {
    expect(typeof PROMPT_VERSION).toBe("string");
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
