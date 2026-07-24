/**
 * Ports for system-level side effects.
 *
 * These interfaces are the seams that keep the wall clock, randomness, subprocesses, and the
 * filesystem out of the domain and application layers, so behaviour is deterministic and fully
 * fakeable.
 */

/** Outcome of a subprocess execution. */
export interface ProcessResult {
  /** `null` when the process was killed before exiting (i.e. on timeout). */
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
}

/** Provides the current time (always UTC — `Date` is an absolute instant). */
export interface Clock {
  now(): Date;
}

/** Generates unique identifiers. */
export interface IdGenerator {
  newId(): string;
}

/** Runs an external command without a shell, bounded by a hard timeout. */
export interface SubprocessRunner {
  run(
    command: readonly string[],
    options: { timeoutSeconds: number; cwd?: string },
  ): Promise<ProcessResult>;
}

/**
 * An isolated temporary directory that removes itself on disposal.
 *
 * Consumed with `await using`, the direct analogue of the Python original's `with` block: the
 * directory and everything written into it is deleted when the scope exits, on success or failure.
 */
export interface Workspace extends AsyncDisposable {
  readonly path: string;
}

/** Creates isolated temporary directories with guaranteed cleanup. */
export interface TempWorkspace {
  create(): Promise<Workspace>;
}
