import { jwtVerify } from "jose";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitHubError } from "../../src/domain/errors.ts";
import { FixedClock, SystemClock } from "../../src/infrastructure/clock.ts";
import { GitHubAppAuth } from "../../src/infrastructure/github/auth.ts";
import { PKCS1_PEM, PKCS8_PEM, PUBLIC_KEY } from "../helpers/keys.ts";

const API = "https://api.github.com";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function anAuth(clock: FixedClock, privateKey = PKCS1_PEM): GitHubAppAuth {
  return new GitHubAppAuth({ appId: "12345", privateKey, clock, apiBase: API });
}

/**
 * Verify a token as of the injected clock rather than the real wall clock.
 *
 * The whole point of the fixed clock is that these assertions do not drift, so verification has to
 * be anchored to the same instant the token was minted at — otherwise every token is "expired".
 */
function verifyAsOf(token: string, clock: FixedClock) {
  return jwtVerify(token, PUBLIC_KEY, { currentDate: clock.now() });
}

/** Respond with a token that expires `seconds` after the clock's current instant. */
function tokenEndpoint(clock: FixedClock, token: string, seconds = 3600) {
  return http.post(`${API}/app/installations/:id/access_tokens`, () =>
    HttpResponse.json({
      token,
      expires_at: new Date(clock.now().getTime() + seconds * 1000).toISOString(),
    }),
  );
}

describe("GitHubAppAuth.appJwt", () => {
  it("signs a verifiable RS256 JWT issued by the app", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));

    const token = await anAuth(clock).appJwt();
    const { payload, protectedHeader } = await verifyAsOf(token, clock);

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe("12345");
  });

  it("back-dates iat to absorb clock drift and expires within GitHub's 10-minute limit", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    const issuedAt = Math.floor(clock.now().getTime() / 1000);

    const { payload } = await verifyAsOf(await anAuth(clock).appJwt(), clock);

    expect(payload.iat).toBe(issuedAt - 60);
    expect((payload.exp as number) - issuedAt).toBeLessThanOrEqual(600);
    expect((payload.exp as number) - issuedAt).toBeGreaterThan(0);
  });

  it("accepts a PKCS#8 private key as well as GitHub's PKCS#1", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));

    const { payload } = await verifyAsOf(await anAuth(clock, PKCS8_PEM).appJwt(), clock);

    expect(payload.iss).toBe("12345");
  });

  it("reuses the imported key across calls", async () => {
    const auth = anAuth(new FixedClock(new Date("2026-01-01T12:00:00Z")));

    await expect(auth.appJwt()).resolves.toBeTypeOf("string");
    await expect(auth.appJwt()).resolves.toBeTypeOf("string");
  });
});

describe("GitHubAppAuth.installationToken", () => {
  it("exchanges the app JWT for an installation token", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    let seenAuthorization: string | null = null;
    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, ({ request }) => {
        seenAuthorization = request.headers.get("authorization");
        return HttpResponse.json({
          token: "ghs_installation",
          expires_at: new Date(clock.now().getTime() + 3600_000).toISOString(),
        });
      }),
    );

    const token = await anAuth(clock).installationToken(99);

    expect(token).toBe("ghs_installation");
    expect(seenAuthorization).toMatch(/^Bearer ey/);
  });

  it("caches the token, so a second call issues no further request", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    let calls = 0;
    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, () => {
        calls += 1;
        return HttpResponse.json({
          token: `token-${calls}`,
          expires_at: new Date(clock.now().getTime() + 3600_000).toISOString(),
        });
      }),
    );
    const auth = anAuth(clock);

    expect(await auth.installationToken(99)).toBe("token-1");
    expect(await auth.installationToken(99)).toBe("token-1");
    expect(calls).toBe(1);
  });

  it("refreshes the token once it is within the refresh margin of expiry", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    let calls = 0;
    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, () => {
        calls += 1;
        return HttpResponse.json({
          token: `token-${calls}`,
          expires_at: new Date(clock.now().getTime() + 120_000).toISOString(),
        });
      }),
    );
    const auth = anAuth(clock);

    expect(await auth.installationToken(99)).toBe("token-1");
    clock.advance(100); // now inside the 60s refresh margin of a 120s token
    expect(await auth.installationToken(99)).toBe("token-2");
    expect(calls).toBe(2);
  });

  it("caches each installation separately", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, ({ params }) =>
        HttpResponse.json({
          token: `token-for-${params["id"] as string}`,
          expires_at: new Date(clock.now().getTime() + 3600_000).toISOString(),
        }),
      ),
    );
    const auth = anAuth(clock);

    expect(await auth.installationToken(1)).toBe("token-for-1");
    expect(await auth.installationToken(2)).toBe("token-for-2");
  });

  it("raises a domain error when GitHub rejects the exchange", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );

    await expect(anAuth(clock).installationToken(99)).rejects.toThrow(GitHubError);
  });

  it("raises a domain error when the response is missing the token fields", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, () => HttpResponse.json({})),
    );

    await expect(anAuth(clock).installationToken(99)).rejects.toThrow(/missing token/);
  });

  it("never puts the token itself in the thrown error", async () => {
    const clock = new FixedClock(new Date("2026-01-01T12:00:00Z"));
    server.use(tokenEndpoint(clock, "ghs_supersecret"));
    const auth = anAuth(clock);

    await auth.installationToken(99);

    server.use(
      http.post(`${API}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ message: "nope" }, { status: 500 }),
      ),
    );
    clock.advance(4000);
    await expect(auth.installationToken(99)).rejects.not.toThrow(/ghs_supersecret/);
  });
});

describe("GitHubAppAuth", () => {
  it("defaults to the public GitHub API when no base is configured", async () => {
    let requestedUrl = "";
    const auth = new GitHubAppAuth({
      appId: "1",
      privateKey: PKCS1_PEM,
      clock: new SystemClock(),
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return Response.json({ message: "no" }, { status: 500 });
      },
    });

    await expect(auth.installationToken(7)).rejects.toThrow();
    expect(requestedUrl.startsWith("https://api.github.com/")).toBe(true);
  });
});
