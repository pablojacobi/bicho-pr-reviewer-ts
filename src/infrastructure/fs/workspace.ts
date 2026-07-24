/**
 * Temporary workspace with guaranteed cleanup.
 *
 * The returned handle is an `AsyncDisposable`, so callers write `await using ws = …` and the
 * directory is removed when the scope exits — the direct analogue of the Python original's `with`
 * block, including cleanup on the failure path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TempWorkspace, Workspace } from "../../domain/ports/system.ts";

/** Creates isolated temporary directories and always removes them afterwards. */
export class TempWorkspaceFactory implements TempWorkspace {
  readonly #prefix: string;
  readonly #root: string;

  constructor(options: { prefix?: string; root?: string } = {}) {
    this.#prefix = options.prefix ?? "bicho-";
    this.#root = options.root ?? tmpdir();
  }

  async create(): Promise<Workspace> {
    const path = await mkdtemp(join(this.#root, this.#prefix));
    return {
      path,
      [Symbol.asyncDispose]: async () => {
        await rm(path, { recursive: true, force: true });
      },
    };
  }
}
