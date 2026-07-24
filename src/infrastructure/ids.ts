/** Identifier generation. */

import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../domain/ports/system.ts";

/** An {@link IdGenerator} producing random UUIDv4 hex strings (no dashes). */
export class UuidGenerator implements IdGenerator {
  newId(): string {
    return randomUUID().replaceAll("-", "");
  }
}

/** An {@link IdGenerator} producing predictable sequential ids, for deterministic tests. */
export class SequentialIdGenerator implements IdGenerator {
  #counter = 0;
  readonly #prefix: string;

  constructor(prefix = "id") {
    this.#prefix = prefix;
  }

  newId(): string {
    this.#counter += 1;
    return `${this.#prefix}-${this.#counter}`;
  }
}
