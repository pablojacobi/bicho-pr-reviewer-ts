/**
 * A test-only RSA key pair.
 *
 * Generated once per test process rather than checked in, so no private key — even a throwaway one
 * — ever lives in the repository. Both PKCS#1 and PKCS#8 encodings are exported: GitHub hands out
 * PKCS#1, and the auth adapter must accept either.
 */

import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const PKCS1_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const PKCS8_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
export const PUBLIC_KEY = publicKey;
