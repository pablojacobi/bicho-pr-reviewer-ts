/**
 * The domain's error hierarchy.
 *
 * Callers catch these to distinguish the reviewer's own failures from programming errors, so the
 * inheritance chain and the name each error reports are part of its contract rather than incidental.
 */

import { describe, expect, it } from "vitest";
import {
  BichoError,
  GitHubError,
  PullRequestNotFoundError,
  UnsafePathError,
} from "../../src/domain/errors.ts";

describe("BichoError", () => {
  it("reports its own subclass name rather than the base name", () => {
    expect(new BichoError("boom").name).toBe("BichoError");
    expect(new GitHubError("boom").name).toBe("GitHubError");
    expect(new PullRequestNotFoundError("octo/repo#1").name).toBe("PullRequestNotFoundError");
  });

  it("is an Error, so it survives anything that inspects the standard shape", () => {
    const error = new BichoError("boom");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("boom");
    expect(error.stack).toBeTruthy();
  });
});

describe("UnsafePathError", () => {
  it("keeps the offending path for the caller to log or report", () => {
    const error = new UnsafePathError("../secrets.env");

    expect(error.path).toBe("../secrets.env");
    expect(error.message).toContain("../secrets.env");
    expect(error.message).toContain("unsafe path rejected");
  });

  it("is catchable as a domain error", () => {
    expect(new UnsafePathError("x")).toBeInstanceOf(BichoError);
  });
});

describe("GitHub errors", () => {
  it("nests a missing pull request under the GitHub failures", () => {
    const error = new PullRequestNotFoundError("octo/repo#1");

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toBeInstanceOf(BichoError);
  });

  it("keeps unrelated domain errors out of the GitHub branch", () => {
    expect(new UnsafePathError("x")).not.toBeInstanceOf(GitHubError);
  });
});
