/**
 * A deterministic {@link SubprocessRunner} fake for tests and offline runs.
 *
 * Returns pre-scripted results and records the commands it was asked to run, so scanner logic can
 * be exercised without invoking a real binary.
 */

import type { ProcessResult, SubprocessRunner } from "../../domain/ports/system.ts";

/** Build a {@link ProcessResult} from the parts a test cares about. */
export function processResult(parts: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: parts.exitCode ?? 0,
    stdout: parts.stdout ?? Buffer.alloc(0),
    stderr: parts.stderr ?? Buffer.alloc(0),
    timedOut: parts.timedOut ?? false,
  };
}

/** Returns scripted {@link ProcessResult}s in order and records every command. */
export class FakeSubprocessRunner implements SubprocessRunner {
  readonly commands: string[][] = [];
  readonly cwds: (string | undefined)[] = [];
  readonly #results: ProcessResult[];
  readonly #fallback: ProcessResult;

  /**
   * @param results Consumed one per call. Once exhausted, the last one is repeated, so a scanner
   *   that audits several manifests needs only one scripted result unless the test varies them.
   */
  constructor(results: ProcessResult | readonly ProcessResult[] = processResult()) {
    const list = Array.isArray(results) ? [...results] : [results as ProcessResult];
    this.#results = list;
    this.#fallback = list.at(-1) ?? processResult();
  }

  async run(
    command: readonly string[],
    options: { timeoutSeconds: number; cwd?: string },
  ): Promise<ProcessResult> {
    this.commands.push([...command]);
    this.cwds.push(options.cwd);
    return this.#results.length > 1 ? (this.#results.shift() as ProcessResult) : this.#fallback;
  }
}
