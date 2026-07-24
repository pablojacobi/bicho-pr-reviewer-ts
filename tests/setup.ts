import { beforeEach } from "vitest";

/**
 * Deterministic test hygiene.
 *
 * Settings are read from the environment, so any stray `BICHO_`-prefixed variable in the developer's
 * shell (or a leaked `process.env` write from an earlier test) would silently change what a test
 * asserts. Clearing them before every test makes settings load from a known-empty baseline.
 */
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("BICHO_")) {
      delete process.env[key];
    }
  }
});
