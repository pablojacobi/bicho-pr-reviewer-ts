/**
 * A minimal counting semaphore.
 *
 * The Python original used `asyncio.Semaphore` to bound how many calls hit one model provider at
 * once. JavaScript has no built-in equivalent, and this is small enough that a dependency would
 * cost more than it saves — twenty lines, fully testable, no transitive supply chain.
 */
export class Semaphore {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  /** Run `task` while holding a permit, releasing it even if `task` rejects. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return;
    }
    await new Promise<void>((resolvePermit) => this.#waiting.push(resolvePermit));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#available += 1;
    } else {
      // Hand the permit straight to the next waiter instead of returning it to the pool, so a
      // queued caller cannot be overtaken by one that arrives later.
      next();
    }
  }
}
