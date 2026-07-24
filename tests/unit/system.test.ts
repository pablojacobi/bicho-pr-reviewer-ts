import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "../../src/infrastructure/clock.ts";
import { TempWorkspaceFactory } from "../../src/infrastructure/fs/workspace.ts";
import { SequentialIdGenerator, UuidGenerator } from "../../src/infrastructure/ids.ts";
import { FakeSubprocessRunner, processResult } from "../../src/infrastructure/process/fake.ts";
import { NodeSubprocessRunner } from "../../src/infrastructure/process/subprocessRunner.ts";

describe("SystemClock", () => {
  it("reports a time close to now", () => {
    const before = Date.now();

    const now = new SystemClock().now().getTime();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("FixedClock", () => {
  it("always reports the instant it was built with", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));

    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("moves forward by the requested number of seconds", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));

    clock.advance(90);

    expect(clock.now().toISOString()).toBe("2026-01-01T00:01:30.000Z");
  });
});

describe("UuidGenerator", () => {
  it("produces a 32-character hex id", () => {
    expect(new UuidGenerator().newId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different id each time", () => {
    const ids = new UuidGenerator();

    expect(ids.newId()).not.toBe(ids.newId());
  });
});

describe("SequentialIdGenerator", () => {
  it("counts up from one", () => {
    const ids = new SequentialIdGenerator();

    expect(ids.newId()).toBe("id-1");
    expect(ids.newId()).toBe("id-2");
  });

  it("honours a custom prefix", () => {
    expect(new SequentialIdGenerator("finding").newId()).toBe("finding-1");
  });
});

describe("TempWorkspaceFactory", () => {
  it("creates a directory that can be written to, and removes it on disposal", async () => {
    const factory = new TempWorkspaceFactory();
    let path: string;

    {
      await using workspace = await factory.create();
      path = workspace.path;
      await writeFile(join(path, "note.txt"), "hello", "utf8");
      expect(await readFile(join(path, "note.txt"), "utf8")).toBe("hello");
    }

    await expect(access(path)).rejects.toThrow();
  });

  it("removes the directory even when the scope exits with an error", async () => {
    const factory = new TempWorkspaceFactory();
    let path = "";

    await expect(
      (async () => {
        await using workspace = await factory.create();
        path = workspace.path;
        throw new Error("boom");
      })(),
    ).rejects.toThrow("boom");

    await expect(access(path)).rejects.toThrow();
  });

  it("creates isolated directories for concurrent workspaces", async () => {
    const factory = new TempWorkspaceFactory();

    await using first = await factory.create();
    await using second = await factory.create();

    expect(first.path).not.toBe(second.path);
  });

  it("honours a custom prefix", async () => {
    await using workspace = await new TempWorkspaceFactory({ prefix: "custom-" }).create();

    expect(workspace.path).toContain("custom-");
  });
});

describe("NodeSubprocessRunner", () => {
  const runner = new NodeSubprocessRunner();

  it("captures stdout and a zero exit code", async () => {
    const result = await runner.run(["node", "-e", "process.stdout.write('hi')"], {
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("hi");
    expect(result.timedOut).toBe(false);
  });

  it("reports a non-zero exit code with stderr", async () => {
    const result = await runner.run(
      ["node", "-e", "process.stderr.write('bad'); process.exit(3)"],
      { timeoutSeconds: 30 },
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toBe("bad");
    expect(result.timedOut).toBe(false);
  });

  it("kills a command that exceeds its timeout and flags it", async () => {
    const result = await runner.run(["node", "-e", "setTimeout(() => {}, 10_000)"], {
      timeoutSeconds: 0.25,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("reports a missing executable as a failure rather than throwing", async () => {
    const result = await runner.run(["bicho-does-not-exist"], { timeoutSeconds: 5 });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("runs in the requested working directory", async () => {
    await using workspace = await new TempWorkspaceFactory().create();

    const result = await runner.run(["node", "-e", "process.stdout.write(process.cwd())"], {
      timeoutSeconds: 30,
      cwd: workspace.path,
    });

    expect(result.stdout.toString()).toContain(workspace.path.split("/").pop() as string);
  });

  it("does not interpret the command through a shell", async () => {
    // With a shell this would expand to two commands; without one it is a single literal argument.
    const result = await runner.run(["node", "-e", "process.stdout.write('a; echo b')"], {
      timeoutSeconds: 30,
    });

    expect(result.stdout.toString()).toBe("a; echo b");
  });

  it("rejects an empty command", async () => {
    await expect(runner.run([], { timeoutSeconds: 5 })).rejects.toThrow(TypeError);
  });
});

describe("FakeSubprocessRunner", () => {
  it("records the commands and working directories it was given", async () => {
    const runner = new FakeSubprocessRunner(processResult({ stdout: Buffer.from("{}") }));

    await runner.run(["semgrep", "scan"], { timeoutSeconds: 1, cwd: "/tmp/ws" });

    expect(runner.commands).toEqual([["semgrep", "scan"]]);
    expect(runner.cwds).toEqual(["/tmp/ws"]);
  });

  it("returns scripted results in order, then repeats the last one", async () => {
    const runner = new FakeSubprocessRunner([
      processResult({ exitCode: 0 }),
      processResult({ exitCode: 7 }),
    ]);

    expect((await runner.run(["a"], { timeoutSeconds: 1 })).exitCode).toBe(0);
    expect((await runner.run(["a"], { timeoutSeconds: 1 })).exitCode).toBe(7);
    expect((await runner.run(["a"], { timeoutSeconds: 1 })).exitCode).toBe(7);
  });

  it("defaults to a successful, empty result", async () => {
    const result = await new FakeSubprocessRunner().run(["a"], { timeoutSeconds: 1 });

    expect(result).toEqual({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
    });
  });

  it("falls back to a default result when scripted with an empty list", async () => {
    const result = await new FakeSubprocessRunner([]).run(["a"], { timeoutSeconds: 1 });

    expect(result.exitCode).toBe(0);
  });
});
