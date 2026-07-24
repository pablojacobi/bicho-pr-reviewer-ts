/** System clock implementation. */

import type { Clock } from "../domain/ports/system.ts";

/** A {@link Clock} backed by the real wall clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A {@link Clock} frozen at a fixed instant, for deterministic tests. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(current: Date) {
    this.#current = current;
  }

  now(): Date {
    return this.#current;
  }

  /** Move the clock forward by `seconds` (used to exercise cache-expiry paths). */
  advance(seconds: number): void {
    this.#current = new Date(this.#current.getTime() + seconds * 1000);
  }
}
