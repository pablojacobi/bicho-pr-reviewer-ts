/**
 * Domain-level exceptions.
 *
 * A small hierarchy rooted at {@link BichoError} so callers can catch the domain's own failures
 * without resorting to a bare `catch (e)` that also swallows programming errors.
 */

/** Base class for all Bicho domain errors. */
export class BichoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a repository-supplied path is unsafe to materialize (traversal/absolute). */
export class UnsafePathError extends BichoError {
  readonly path: string;

  constructor(path: string) {
    super(`unsafe path rejected: ${JSON.stringify(path)}`);
    this.path = path;
  }
}

/** Base class for failures interacting with GitHub. */
export class GitHubError extends BichoError {}

/** Thrown when the requested pull request does not exist or is inaccessible. */
export class PullRequestNotFoundError extends GitHubError {}
