/**
 * Webhook signature verification.
 *
 * GitHub signs each webhook with HMAC-SHA256 over the raw body, sent as
 * `X-Hub-Signature-256: sha256=<hex>`. Verification uses the *raw* bytes (never the re-serialized
 * JSON, which would differ by key order or whitespace) and a constant-time compare, so a wrong or
 * missing signature is rejected before the body is parsed at all.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** Whether `signatureHeader` is a valid HMAC-SHA256 of `body` under `secret`. */
export function verifySignature(
  secret: string,
  body: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith(PREFIX)) {
    return false;
  }
  const expected = Buffer.from(
    `${PREFIX}${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  const received = Buffer.from(signatureHeader);
  // timingSafeEqual throws on a length mismatch, which would itself leak length by timing out of
  // the comparison early; check the length first and compare the bytes in constant time.
  return expected.length === received.length && timingSafeEqual(expected, received);
}
