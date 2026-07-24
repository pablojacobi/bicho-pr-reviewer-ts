import { describe, expect, it } from "vitest";
import { envBoolean, envInteger, envNumber, expandEnv, toCamelCase } from "../../src/config/env.ts";
import { Environment, isProduction } from "../../src/config/environment.ts";
import { missingRequirements } from "../../src/config/readiness.ts";
import {
  activeProvider,
  loadSettings,
  renderJsonLogs,
  type Settings,
} from "../../src/config/settings.ts";

describe("Environment", () => {
  it("identifies only production as production", () => {
    expect(isProduction(Environment.PRODUCTION)).toBe(true);
    expect(isProduction(Environment.LOCAL)).toBe(false);
    expect(isProduction(Environment.TEST)).toBe(false);
  });
});

describe("toCamelCase", () => {
  it.each([
    ["APP_ID", "appId"],
    ["MODEL", "model"],
    ["RETRY_DELAY_SECONDS", "retryDelaySeconds"],
    ["MINIMAX", "minimax"],
  ])("converts %s to %s", (input, expected) => {
    expect(toCamelCase(input)).toBe(expected);
  });

  it("returns an empty string for an empty segment", () => {
    expect(toCamelCase("")).toBe("");
  });
});

describe("expandEnv", () => {
  it("ignores variables without the BICHO_ prefix", () => {
    expect(expandEnv({ PATH: "/usr/bin", HOME: "/root" })).toEqual({});
  });

  it("maps a flat variable to a camel-cased key", () => {
    expect(expandEnv({ BICHO_LOG_LEVEL: "debug" })).toEqual({ logLevel: "debug" });
  });

  it("nests on the double-underscore delimiter", () => {
    expect(expandEnv({ BICHO_GITHUB__APP_ID: "123" })).toEqual({ github: { appId: "123" } });
  });

  it("nests arbitrarily deep, camel-casing every segment", () => {
    expect(expandEnv({ BICHO_LLM__PROVIDERS__MINIMAX__API_KEY: "k" })).toEqual({
      llm: { providers: { minimax: { apiKey: "k" } } },
    });
  });

  it("treats an empty value as unset", () => {
    expect(expandEnv({ BICHO_LOG_LEVEL: "" })).toEqual({});
  });

  it("ignores an undefined value", () => {
    expect(expandEnv({ BICHO_LOG_LEVEL: undefined })).toEqual({});
  });

  it("ignores a variable that is only the prefix", () => {
    expect(expandEnv({ BICHO_: "x" })).toEqual({});
  });

  it("lets the nested form win when a scalar already occupies the section", () => {
    expect(expandEnv({ BICHO_GITHUB: "scalar", BICHO_GITHUB__APP_ID: "1" })).toEqual({
      github: { appId: "1" },
    });
  });

  it("merges sibling keys into one section", () => {
    expect(expandEnv({ BICHO_GITHUB__APP_ID: "1", BICHO_GITHUB__API_BASE: "https://x" })).toEqual({
      github: { appId: "1", apiBase: "https://x" },
    });
  });
});

describe("env coercion", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
    [" true ", true],
  ])("parses %s as %s", (input, expected) => {
    expect(envBoolean.parse(input)).toBe(expected);
  });

  it("passes an actual boolean through", () => {
    expect(envBoolean.parse(true)).toBe(true);
  });

  it("rejects a non-boolean string rather than silently defaulting", () => {
    expect(() => envBoolean.parse("maybe")).toThrow(/invalid boolean/);
  });

  it("parses numbers from strings", () => {
    expect(envNumber.parse("60.5")).toBe(60.5);
    expect(envNumber.parse(12)).toBe(12);
  });

  it("rejects a non-numeric string", () => {
    expect(() => envNumber.parse("soon")).toThrow(/invalid number/);
  });

  it("rejects a non-finite number", () => {
    expect(() => envNumber.parse("Infinity")).toThrow(/invalid number/);
  });

  it("rejects a non-integer where an integer is required", () => {
    expect(() => envInteger.parse("1.5")).toThrow();
    expect(envInteger.parse("42")).toBe(42);
  });
});

describe("loadSettings", () => {
  it("falls back to safe defaults when nothing is configured", () => {
    const settings = loadSettings({});

    expect(settings.environment).toBe(Environment.LOCAL);
    expect(settings.logLevel).toBe("info");
    expect(settings.jsonLogs).toBeNull();
    expect(settings.github.apiBase).toBe("https://api.github.com");
    expect(settings.github.installationId).toBe(0);
    expect(settings.llm.active).toBe("minimax");
    expect(settings.llm.providers).toEqual({});
    expect(settings.scanner.semgrepEnabled).toBe(true);
    expect(settings.scanner.npmAuditEnabled).toBe(true);
    expect(settings.reviewTimeoutSeconds).toBe(300);
    expect(settings.verifierEnabled).toBe(false);
  });

  it("reads a nested provider block", () => {
    const settings = loadSettings({
      BICHO_LLM__ACTIVE: "minimax",
      BICHO_LLM__PROVIDERS__MINIMAX__API_KEY: "secret",
      BICHO_LLM__PROVIDERS__MINIMAX__BASE_URL: "https://api.minimax.io/v1",
      BICHO_LLM__PROVIDERS__MINIMAX__MODEL: "minimax-m3",
      BICHO_LLM__PROVIDERS__MINIMAX__MAX_ATTEMPTS: "4",
    });

    const provider = activeProvider(settings);

    expect(provider.apiKey).toBe("secret");
    expect(provider.model).toBe("minimax-m3");
    expect(provider.maxAttempts).toBe(4);
    expect(provider.timeoutSeconds).toBe(60);
  });

  it("returns an empty provider spec when the active provider is not configured", () => {
    const provider = activeProvider(loadSettings({ BICHO_LLM__ACTIVE: "absent" }));

    expect(provider.model).toBe("");
    expect(provider.apiKey).toBe("");
  });

  it("accepts a log level in any case", () => {
    expect(loadSettings({ BICHO_LOG_LEVEL: "WARN" }).logLevel).toBe("warn");
  });

  it("rejects an unknown log level", () => {
    expect(() => loadSettings({ BICHO_LOG_LEVEL: "chatty" })).toThrow();
  });

  it("rejects an unknown environment", () => {
    expect(() => loadSettings({ BICHO_ENVIRONMENT: "staging" })).toThrow();
  });

  it("restores real newlines in a single-line PEM private key", () => {
    const settings = loadSettings({
      BICHO_GITHUB__PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
    });

    expect(settings.github.privateKey).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

  it("reads booleans from their textual spellings", () => {
    const settings = loadSettings({
      BICHO_SCANNER__SEMGREP_ENABLED: "false",
      BICHO_VERIFIER_ENABLED: "1",
    });

    expect(settings.scanner.semgrepEnabled).toBe(false);
    expect(settings.verifierEnabled).toBe(true);
  });

  it("defaults to the real process environment", () => {
    process.env["BICHO_LOG_LEVEL"] = "error";

    expect(loadSettings().logLevel).toBe("error");
  });
});

describe("renderJsonLogs", () => {
  it("renders JSON in production by default", () => {
    expect(renderJsonLogs(loadSettings({ BICHO_ENVIRONMENT: "production" }))).toBe(true);
  });

  it("renders human-readable logs outside production by default", () => {
    expect(renderJsonLogs(loadSettings({ BICHO_ENVIRONMENT: "local" }))).toBe(false);
  });

  it("honours an explicit override in either direction", () => {
    expect(
      renderJsonLogs(loadSettings({ BICHO_ENVIRONMENT: "production", BICHO_JSON_LOGS: "false" })),
    ).toBe(false);
    expect(
      renderJsonLogs(loadSettings({ BICHO_ENVIRONMENT: "local", BICHO_JSON_LOGS: "true" })),
    ).toBe(true);
  });
});

describe("missingRequirements", () => {
  const configured: NodeJS.ProcessEnv = {
    BICHO_GITHUB__APP_ID: "1",
    BICHO_GITHUB__PRIVATE_KEY: "pem",
    BICHO_GITHUB__INSTALLATION_ID: "99",
    BICHO_LLM__ACTIVE: "minimax",
    BICHO_LLM__PROVIDERS__MINIMAX__API_KEY: "k",
    BICHO_LLM__PROVIDERS__MINIMAX__BASE_URL: "https://api.minimax.io/v1",
    BICHO_LLM__PROVIDERS__MINIMAX__MODEL: "minimax-m3",
  };

  const withoutKey = (key: string): Settings => {
    const env = { ...configured };
    delete env[key];
    return loadSettings(env);
  };

  it("reports nothing when everything required is present", () => {
    expect(missingRequirements(loadSettings(configured))).toEqual([]);
  });

  it("reports every missing requirement on a bare configuration", () => {
    const problems = missingRequirements(loadSettings({}));

    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/app_?Id|appId/i);
  });

  it.each([
    ["BICHO_GITHUB__APP_ID", /appId/],
    ["BICHO_GITHUB__PRIVATE_KEY", /privateKey/],
    ["BICHO_GITHUB__INSTALLATION_ID", /installationId/],
  ])("reports %s when it is absent", (key, pattern) => {
    expect(missingRequirements(withoutKey(key)).join("\n")).toMatch(pattern);
  });

  it("reports an active provider that is not configured at all", () => {
    const settings = loadSettings({ ...configured, BICHO_LLM__ACTIVE: "gemini" });

    expect(missingRequirements(settings).join("\n")).toMatch(/is not in llm.providers/);
  });

  it("reports an active provider missing its model", () => {
    expect(
      missingRequirements(withoutKey("BICHO_LLM__PROVIDERS__MINIMAX__MODEL")).join("\n"),
    ).toMatch(/missing apiKey\/baseUrl\/model/);
  });
});
