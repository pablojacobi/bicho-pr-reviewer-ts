import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../../src/api/security.ts";

const secret = "shh-secret";
const body = Buffer.from(JSON.stringify({ action: "opened", number: 42 }), "utf8");

function sign(key: string, payload: Buffer): string {
  return `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;
}

/** Flip the last hex digit, guaranteeing a different value of the same length. */
function flipLastHexChar(hex: string): string {
  const last = hex.slice(-1);
  const replacement = last === "0" ? "1" : "0";
  return `${hex.slice(0, -1)}${replacement}`;
}

describe("verifySignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifySignature(secret, body, sign(secret, body))).toBe(true);
  });

  it("rejects a wrong signature of the same length", () => {
    const correctHeader = sign(secret, body);
    const digest = correctHeader.slice("sha256=".length);
    const wrongHeader = `sha256=${flipLastHexChar(digest)}`;

    expect(wrongHeader).not.toBe(correctHeader);
    expect(wrongHeader.length).toBe(correctHeader.length);
    expect(verifySignature(secret, body, wrongHeader)).toBe(false);
  });

  it("rejects a signature of a different length", () => {
    const tooLong = `${sign(secret, body)}00`;

    expect(verifySignature(secret, body, tooLong)).toBe(false);
  });

  it("rejects an undefined signature header", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const digestOnly = sign(secret, body).slice("sha256=".length);

    expect(verifySignature(secret, body, digestOnly)).toBe(false);
  });

  it("rejects when the body differs from what was signed by a single byte", () => {
    const header = sign(secret, body);
    const tamperedBody = Buffer.from(body);
    tamperedBody[0] = (tamperedBody[0] ?? 0) ^ 0xff;

    expect(verifySignature(secret, tamperedBody, header)).toBe(false);
  });

  it("rejects an empty-string signature header", () => {
    expect(verifySignature(secret, body, "")).toBe(false);
  });
});
