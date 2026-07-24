import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/infrastructure/model/semaphore.ts";

/** A manually-resolvable promise, so a test can control exactly when a task "finishes". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("runs a task and returns its value", async () => {
    const semaphore = new Semaphore(1);

    const result = await semaphore.run(async () => 42);

    expect(result).toBe(42);
  });

  it("releases the permit when the task throws, so a later task still runs", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const result = await semaphore.run(async () => "after");

    expect(result).toBe("after");
  });

  it("with permits=1, a second call waits until the first completes", async () => {
    const semaphore = new Semaphore(1);
    const sequence: string[] = [];
    const gate = deferred<void>();

    const first = semaphore.run(async () => {
      sequence.push("first-start");
      await gate.promise;
      sequence.push("first-end");
      return "first";
    });
    const second = semaphore.run(async () => {
      sequence.push("second-start");
      return "second";
    });

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // "second-start" cannot be recorded until `#release()` hands the permit on, which only
    // happens once the first task's `finally` runs — i.e. strictly after "first-end".
    expect(sequence).toEqual(["first-start", "first-end", "second-start"]);
    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
  });

  it("with permits=2, two tasks run concurrently", async () => {
    const semaphore = new Semaphore(2);
    const sequence: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const a = semaphore.run(async () => {
      sequence.push("a-start");
      await gateA.promise;
      sequence.push("a-end");
    });
    const b = semaphore.run(async () => {
      sequence.push("b-start");
      await gateB.promise;
      sequence.push("b-end");
    });

    // Flush the microtask queue without touching real time: with two permits, both tasks should
    // have started even though neither gate has been released yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(sequence).toEqual(["a-start", "b-start"]);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);

    expect(sequence).toEqual(["a-start", "b-start", "a-end", "b-end"]);
  });

  it("serves queued waiters in FIFO order", async () => {
    const semaphore = new Semaphore(1);
    const sequence: string[] = [];
    const gate = deferred<void>();

    const first = semaphore.run(async () => {
      sequence.push("first");
      await gate.promise;
    });
    // Both queue behind `first` while it holds the only permit.
    const second = semaphore.run(async () => {
      sequence.push("second");
    });
    const third = semaphore.run(async () => {
      sequence.push("third");
    });

    gate.resolve();
    await Promise.all([first, second, third]);

    expect(sequence).toEqual(["first", "second", "third"]);
  });
});
