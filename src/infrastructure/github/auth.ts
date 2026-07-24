/**
 * GitHub App authentication: an app JWT exchanged for a cached installation access token.
 *
 * The app JWT is RS256-signed with the app's private key (`iat` back-dated to absorb clock drift,
 * `exp` within GitHub's 10-minute limit). Installation tokens (~1h) are cached until near expiry.
 *
 * The key is loaded with `node:crypto`'s `createPrivateKey` rather than jose's `importPKCS8`:
 * GitHub hands out PKCS#1 PEMs (`BEGIN RSA PRIVATE KEY`), which `importPKCS8` rejects outright,
 * while `createPrivateKey` accepts both PKCS#1 and PKCS#8.
 */

import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { GitHubError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/ports/system.ts";

const JWT_LIFETIME_SECONDS = 540;
const REFRESH_MARGIN_SECONDS = 60;

interface CachedToken {
  readonly token: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

interface AccessTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/** Signs app JWTs and exchanges them for installation tokens, cached until near expiry. */
export class GitHubAppAuth {
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;
  readonly #apiBase: string;
  readonly #cache = new Map<number, CachedToken>();
  #key: KeyObject | null = null;

  constructor(options: {
    appId: string;
    privateKey: string;
    clock: Clock;
    apiBase?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#appId = options.appId;
    this.#privateKey = options.privateKey;
    this.#clock = options.clock;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  }

  /** Return a short-lived RS256 JWT identifying the GitHub App. */
  async appJwt(): Promise<string> {
    const issued = Math.floor(this.#clock.now().getTime() / 1000);
    this.#key ??= createPrivateKey(this.#privateKey);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.#appId)
      .setIssuedAt(issued - REFRESH_MARGIN_SECONDS)
      .setExpirationTime(issued + JWT_LIFETIME_SECONDS)
      .sign(this.#key);
  }

  /** Return a valid installation access token, refreshing it when near expiry. */
  async installationToken(installationId: number): Promise<string> {
    const now = this.#clock.now().getTime() / 1000;
    const cached = this.#cache.get(installationId);
    if (cached !== undefined && cached.expiresAt > now + REFRESH_MARGIN_SECONDS) {
      return cached.token;
    }

    const response = await this.#fetch(
      `${this.#apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.appJwt()}`,
          accept: "application/vnd.github+json",
        },
      },
    );
    if (!response.ok) {
      throw new GitHubError(
        `could not mint an installation token for ${installationId}: ${response.status}`,
      );
    }
    const data = (await response.json()) as AccessTokenResponse;
    if (typeof data.token !== "string" || typeof data.expires_at !== "string") {
      throw new GitHubError("installation token response was missing token/expires_at");
    }
    this.#cache.set(installationId, {
      token: data.token,
      expiresAt: Date.parse(data.expires_at) / 1000,
    });
    return data.token;
  }
}
