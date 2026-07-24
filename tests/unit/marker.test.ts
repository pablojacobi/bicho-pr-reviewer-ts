import { describe, expect, it } from "vitest";
import { parseMarker, type ReviewMarker, renderMarker } from "../../src/domain/models/marker.ts";

const marker: ReviewMarker = {
  headSha: "abc123",
  workflowVersion: "1",
  runFingerprint: "deadbeef",
  modelId: "minimax-m3",
  promptVersion: "v1",
};

describe("review marker", () => {
  it("renders as a hidden HTML comment", () => {
    const rendered = renderMarker(marker);

    expect(rendered.startsWith("<!--")).toBe(true);
    expect(rendered.endsWith("-->")).toBe(true);
    expect(rendered).toContain("bicho-pr-reviewer:1");
    expect(rendered).toContain("head_sha=abc123");
  });

  it("round-trips through render and parse", () => {
    expect(parseMarker(renderMarker(marker))).toEqual(marker);
  });

  it("finds a marker embedded in a longer review body", () => {
    const body = `## Bicho PR Review\n\n2 confirmed finding(s).\n\n${renderMarker(marker)}\n`;

    expect(parseMarker(body)).toEqual(marker);
  });

  it("returns null when there is no marker", () => {
    expect(parseMarker("just a normal review body")).toBeNull();
  });

  it("returns null for a marker with a different version prefix", () => {
    expect(parseMarker("<!-- bicho-pr-reviewer:2 head_sha=abc -->")).toBeNull();
  });

  it.each([
    ["head_sha", "<!-- bicho-pr-reviewer:1 workflow_version=1 run=d model=m prompt=v1 -->"],
    ["workflow_version", "<!-- bicho-pr-reviewer:1 head_sha=a run=d model=m prompt=v1 -->"],
    ["run", "<!-- bicho-pr-reviewer:1 head_sha=a workflow_version=1 model=m prompt=v1 -->"],
    ["model", "<!-- bicho-pr-reviewer:1 head_sha=a workflow_version=1 run=d prompt=v1 -->"],
    ["prompt", "<!-- bicho-pr-reviewer:1 head_sha=a workflow_version=1 run=d model=m -->"],
  ])("returns null when the %s field is missing", (_field, body) => {
    expect(parseMarker(body)).toBeNull();
  });

  it("parses successive bodies independently (the field regex is not left mid-scan)", () => {
    const body = renderMarker(marker);

    expect(parseMarker(body)).toEqual(marker);
    expect(parseMarker(body)).toEqual(marker);
  });
});

describe("parseMarker", () => {
  it("rejects a marker that carries no fields at all", () => {
    expect(parseMarker("<!--bicho-pr-reviewer:1-->")).toBeNull();
  });
});
