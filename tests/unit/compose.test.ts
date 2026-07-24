import { describe, expect, it } from "vitest";
import { composeReviewDraft, WORKFLOW_VERSION } from "../../src/application/graph/compose.ts";
import { PROMPT_VERSION } from "../../src/application/prompts/registry.ts";
import {
  type AnalyzerOutcome,
  makeOutcome,
  OutcomeStatus,
} from "../../src/domain/models/analysis.ts";
import {
  Category,
  DiffSide,
  Severity,
  VerificationState,
} from "../../src/domain/models/finding.ts";
import { parseMarker } from "../../src/domain/models/marker.ts";
import { aDiff, aFinding, aPullRequest } from "../helpers/factories.ts";

const diff = aDiff();
const pullRequest = aPullRequest({ headSha: "headsha" });

describe("composeReviewDraft", () => {
  it("includes only CONFIRMED findings, excluding candidates and rejected ones entirely", () => {
    const confirmed = aFinding({
      id: "a",
      verificationState: VerificationState.CONFIRMED,
      title: "Confirmed issue",
    });
    const candidate = aFinding({
      id: "b",
      verificationState: VerificationState.CANDIDATE,
      title: "Candidate issue",
    });
    const rejected = aFinding({
      id: "c",
      verificationState: VerificationState.REJECTED,
      title: "Rejected issue",
    });

    const draft = composeReviewDraft({
      findings: [confirmed, candidate, rejected],
      diff,
      pullRequest,
      outcomes: [],
    });

    expect(draft.inlineComments).toHaveLength(1);
    expect(draft.inlineComments[0]?.body).toContain("Confirmed issue");
    expect(draft.summary).not.toContain("Candidate issue");
    expect(draft.summary).not.toContain("Rejected issue");
  });

  it("renders an inline comment body with category, severity, title, explanation, impact, and recommendation", () => {
    const finding = aFinding({
      verificationState: VerificationState.CONFIRMED,
      category: Category.SECURITY,
      severity: Severity.HIGH,
      title: "SQL injection",
      explanation: "User input reaches the query unescaped.",
      impact: "An attacker can read arbitrary rows.",
      recommendation: "Use a parameterized query.",
      startLine: 11,
      endLine: 11,
    });

    const draft = composeReviewDraft({ findings: [finding], diff, pullRequest, outcomes: [] });

    expect(draft.inlineComments).toHaveLength(1);
    const body = draft.inlineComments[0]?.body ?? "";
    expect(body).toContain(Category.SECURITY);
    expect(body).toContain(Severity.HIGH);
    expect(body).toContain("SQL injection");
    expect(body).toContain("User input reaches the query unescaped.");
    expect(body).toContain("**Impact:** An attacker can read arbitrary rows.");
    expect(body).toContain("**Recommendation:** Use a parameterized query.");
  });

  it.each([
    ["a single-line finding", 11, 11, null, null],
    ["a multi-line finding", 10, 12, 10, DiffSide.RIGHT],
  ])(
    "produces %s with startLine %j and startSide %j",
    (_case, startLine, endLine, expectedStartLine, expectedStartSide) => {
      const finding = aFinding({
        verificationState: VerificationState.CONFIRMED,
        startLine,
        endLine,
      });

      const draft = composeReviewDraft({ findings: [finding], diff, pullRequest, outcomes: [] });

      expect(draft.inlineComments[0]).toMatchObject({
        line: endLine,
        startLine: expectedStartLine,
        startSide: expectedStartSide,
      });
    },
  );

  it("routes a confirmed finding that cannot be anchored to the diff into the summary, not inline", () => {
    const finding = aFinding({
      verificationState: VerificationState.CONFIRMED,
      startLine: 900,
      endLine: 900,
      title: "Out of range",
    });

    const draft = composeReviewDraft({ findings: [finding], diff, pullRequest, outcomes: [] });

    expect(draft.inlineComments).toHaveLength(0);
    expect(draft.summary).toContain("### Findings not anchorable to the diff");
    expect(draft.summary).toContain("app/db.ts:900");
    expect(draft.summary).toContain("Out of range");
  });

  it('summarizes with "No confirmed issues found." when there are zero confirmed findings', () => {
    const draft = composeReviewDraft({ findings: [], diff, pullRequest, outcomes: [] });

    expect(draft.summary).toContain("No confirmed issues found.");
  });

  it("summarizes with the confirmed count otherwise", () => {
    const findings = [
      aFinding({
        id: "a",
        verificationState: VerificationState.CONFIRMED,
        startLine: 10,
        endLine: 10,
      }),
      aFinding({
        id: "b",
        verificationState: VerificationState.CONFIRMED,
        startLine: 11,
        endLine: 11,
      }),
    ];

    const draft = composeReviewDraft({ findings, diff, pullRequest, outcomes: [] });

    expect(draft.summary).toContain("2 confirmed finding(s).");
  });

  it("renders an Analysis notes section listing each diagnostic when an outcome is degraded", () => {
    const outcome: AnalyzerOutcome = makeOutcome({
      source: "security",
      status: OutcomeStatus.ERROR,
      diagnostics: [{ source: "security", status: OutcomeStatus.ERROR, message: "upstream 500" }],
    });

    const draft = composeReviewDraft({ findings: [], diff, pullRequest, outcomes: [outcome] });

    expect(draft.summary).toContain("### Analysis notes");
    expect(draft.summary).toContain("security: error — upstream 500");
  });

  it("renders no Analysis notes section when no outcome is degraded", () => {
    const outcome = makeOutcome({ source: "security", status: OutcomeStatus.OK });

    const draft = composeReviewDraft({ findings: [], diff, pullRequest, outcomes: [outcome] });

    expect(draft.summary).not.toContain("### Analysis notes");
  });

  it("embeds a marker that round-trips and carries the PR head SHA and workflow version", () => {
    const draft = composeReviewDraft({
      findings: [],
      diff,
      pullRequest: aPullRequest({ headSha: "abcdef" }),
      outcomes: [],
    });

    const marker = parseMarker(draft.summary);

    expect(marker).not.toBeNull();
    expect(marker?.headSha).toBe("abcdef");
    expect(marker?.workflowVersion).toBe(WORKFLOW_VERSION);
    expect(marker?.promptVersion).toBe(PROMPT_VERSION);
  });

  it("sets the marker's modelId to the first confirmed finding with a non-null modelId", () => {
    const findings = [
      aFinding({
        id: "a",
        verificationState: VerificationState.CONFIRMED,
        modelId: null,
        startLine: 10,
        endLine: 10,
      }),
      aFinding({
        id: "b",
        verificationState: VerificationState.CONFIRMED,
        modelId: "gpt-x",
        startLine: 11,
        endLine: 11,
      }),
    ];

    const draft = composeReviewDraft({ findings, diff, pullRequest, outcomes: [] });

    expect(parseMarker(draft.summary)?.modelId).toBe("gpt-x");
  });

  it('sets the marker\'s modelId to "none" when no confirmed finding has one', () => {
    const findings = [
      aFinding({
        id: "a",
        verificationState: VerificationState.CONFIRMED,
        modelId: null,
        startLine: 10,
        endLine: 10,
      }),
    ];

    const draft = composeReviewDraft({ findings, diff, pullRequest, outcomes: [] });

    expect(parseMarker(draft.summary)?.modelId).toBe("none");
  });

  it.each([
    [Severity.HIGH, "REQUEST_CHANGES"],
    [Severity.CRITICAL, "REQUEST_CHANGES"],
    [Severity.MEDIUM, "COMMENT"],
  ])("sets event to %s for a confirmed %s finding", (severity, expectedEvent) => {
    const finding = aFinding({
      verificationState: VerificationState.CONFIRMED,
      severity,
      startLine: 10,
      endLine: 10,
    });

    const draft = composeReviewDraft({ findings: [finding], diff, pullRequest, outcomes: [] });

    expect(draft.event).toBe(expectedEvent);
  });

  it("sets commitId to the PR head SHA", () => {
    const draft = composeReviewDraft({
      findings: [],
      diff,
      pullRequest: aPullRequest({ headSha: "zzz999" }),
      outcomes: [],
    });

    expect(draft.commitId).toBe("zzz999");
  });
});
