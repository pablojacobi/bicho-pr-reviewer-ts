/**
 * Async subprocess execution with a hard timeout and no shell.
 *
 * `execFile` is used deliberately over `exec`: the command is an argument vector handed straight to
 * the OS, so nothing in it — including scanner arguments derived from repository content — can be
 * interpreted by a shell.
 */

import { execFile } from "node:child_process";
import type { ProcessResult, SubprocessRunner } from "../../domain/ports/system.ts";

/** Node reports a killed-on-timeout child with this code on the error it raises. */
const TIMEOUT_CODE = "ETIMEDOUT";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
}

/** Runs commands via `execFile` (no shell) and kills them on timeout. */
export class NodeSubprocessRunner implements SubprocessRunner {
  async run(
    command: readonly string[],
    options: { timeoutSeconds: number; cwd?: string },
  ): Promise<ProcessResult> {
    const [executable, ...args] = command;
    if (executable === undefined) {
      throw new TypeError("command must not be empty");
    }
    return new Promise<ProcessResult>((resolvePromise) => {
      execFile(
        executable,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutSeconds * 1000,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "buffer",
        },
        (error: ExecError | null, stdout: Buffer, stderr: Buffer) => {
          resolvePromise(toResult(error, stdout, stderr));
        },
      );
    });
  }
}

function toResult(error: ExecError | null, stdout: Buffer, stderr: Buffer): ProcessResult {
  if (error === null) {
    return { exitCode: 0, stdout, stderr, timedOut: false };
  }
  // A timeout kills the child, so there is no exit code to report — the caller distinguishes this
  // from a non-zero exit, exactly as the original did with `timed_out`.
  if (error.killed === true || error.code === TIMEOUT_CODE) {
    return { exitCode: null, stdout, stderr, timedOut: true };
  }
  return {
    exitCode: typeof error.code === "number" ? error.code : null,
    stdout,
    stderr,
    timedOut: false,
  };
}
