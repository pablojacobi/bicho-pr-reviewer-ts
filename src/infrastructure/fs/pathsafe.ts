/**
 * Filesystem path safety and file classification.
 *
 * Pure helpers used before materializing untrusted repository files into a sandboxed workspace: they
 * reject path traversal / absolute / Windows-style paths and classify files that should be skipped
 * (binary, generated, vendored, oversized). The only I/O is whatever the caller subsequently
 * performs.
 */

import { posix, resolve, sep } from "node:path";
import { UnsafePathError } from "../../domain/errors.ts";

/** Default maximum size (bytes) for a single file we are willing to scan. */
export const MAX_FILE_BYTES = 1_000_000;

const SKIP_MARKERS = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  ".venv/",
  "site-packages/",
  "__pycache__/",
  ".min.",
  ".generated.",
  ".d.ts",
] as const;

/** Whether `raw` is a safe, repository-relative path (not empty/absolute/traversing). */
export function isSafeRelativePath(raw: string): boolean {
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.includes(":")) {
    return false;
  }
  if (posix.isAbsolute(raw)) {
    return false;
  }
  return !raw.split("/").includes("..");
}

/** Characters no path comparison can judge: they must be rejected before resolving. */
function hasUnsafeCharacters(raw: string): boolean {
  return raw === "" || raw.includes("\0") || raw.includes("\\") || raw.includes(":");
}

/**
 * Resolve `relative` under `base`; throw {@link UnsafePathError} if it escapes `base`.
 *
 * Containment is proved by comparing the resolved path against the resolved base, which is what
 * actually stops an escape — traversal, an absolute path, or anything else. Deliberately *not*
 * gated on {@link isSafeRelativePath} first: that would make this check unreachable, leaving the
 * real guarantee resting on a test no input can exercise.
 */
export function resolveWithin(base: string, relative: string): string {
  if (hasUnsafeCharacters(relative)) {
    throw new UnsafePathError(relative);
  }
  const baseResolved = resolve(base);
  const resolved = resolve(baseResolved, relative);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + sep)) {
    throw new UnsafePathError(relative);
  }
  return resolved;
}

/** Heuristic: treat content with a NUL byte in its first 8 KiB as binary. */
export function isProbablyBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0);
}

/** Whether `path` looks generated or vendored and should be skipped. */
export function isGeneratedOrVendored(path: string): boolean {
  const lowered = path.toLowerCase();
  return SKIP_MARKERS.some((marker) => lowered.includes(marker));
}

/** Whether `numBytes` is within the allowed per-file size `limit`. */
export function isWithinSize(numBytes: number, limit: number = MAX_FILE_BYTES): boolean {
  return numBytes <= limit;
}
