/**
 * Stable finding fingerprints.
 *
 * A fingerprint identifies the *same issue* across re-runs and small line drift, so a finding
 * survives unrelated edits elsewhere in the file. It deliberately excludes line numbers and
 * severity (both volatile) and anchors to the code's shape via a whitespace-normalized hash of the
 * offending snippet.
 */

import { createHash } from "node:crypto";

const WHITESPACE = /\s+/g;
/** ASCII unit separator: joins components so no component content can forge a boundary. */
const UNIT_SEPARATOR = "\x1f";

function normalizeSnippet(snippet: string): string {
  return snippet.replace(WHITESPACE, " ").trim();
}

function normalizePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Compute a stable 16-hex-character fingerprint for a finding's identity. */
export function computeFingerprint(input: {
  path: string;
  category: string;
  subcategory: string;
  ruleKey: string;
  enclosingSymbol: string | null;
  snippet: string;
}): string {
  const snippetDigest = sha256Hex(normalizeSnippet(input.snippet));
  const components = [
    normalizePath(input.path),
    input.category,
    input.subcategory,
    input.ruleKey,
    input.enclosingSymbol ?? "",
    snippetDigest,
  ];
  return sha256Hex(components.join(UNIT_SEPARATOR)).slice(0, 16);
}
