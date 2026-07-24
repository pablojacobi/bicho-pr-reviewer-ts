import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnsafePathError } from "../../src/domain/errors.ts";
import {
  isGeneratedOrVendored,
  isProbablyBinary,
  isSafeRelativePath,
  isWithinSize,
  MAX_FILE_BYTES,
  resolveWithin,
} from "../../src/infrastructure/fs/pathsafe.ts";

describe("isSafeRelativePath", () => {
  it.each(["app/db.ts", "a.ts", "deep/nested/dir/file.tsx", "dot.file.ts"])(
    "accepts the relative path %s",
    (path) => {
      expect(isSafeRelativePath(path)).toBe(true);
    },
  );

  it.each([
    ["an empty path", ""],
    ["an absolute path", "/etc/passwd"],
    ["a parent traversal", "../secrets.env"],
    ["a traversal in the middle", "app/../../etc/passwd"],
    ["a backslash separator", "app\\db.ts"],
    ["a drive letter", "C:/windows"],
    ["an embedded NUL", "app/db.ts\0.png"],
  ])("rejects %s", (_case, path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });

  it("accepts a path containing a component that merely starts with dots", () => {
    expect(isSafeRelativePath("app/..hidden/db.ts")).toBe(true);
  });

  it("rejects a path that is exactly a traversal segment", () => {
    expect(isSafeRelativePath("..")).toBe(false);
  });

  it("accepts a single dot segment, which does not escape", () => {
    expect(isSafeRelativePath("./app/db.ts")).toBe(true);
  });
});

describe("resolveWithin", () => {
  it("resolves a safe relative path under the base", () => {
    expect(resolveWithin("/tmp/ws", "app/db.ts")).toBe(join("/tmp/ws", "app/db.ts"));
  });

  it("resolves the base itself for a single-segment path", () => {
    expect(resolveWithin("/tmp/ws", "db.ts")).toBe(join("/tmp/ws", "db.ts"));
  });

  it("throws for a traversal that would escape the base", () => {
    expect(() => resolveWithin("/tmp/ws", "../escape.ts")).toThrow(UnsafePathError);
  });

  it("throws for an absolute path", () => {
    expect(() => resolveWithin("/tmp/ws", "/etc/passwd")).toThrow(UnsafePathError);
  });

  it("names the offending path on the error", () => {
    try {
      resolveWithin("/tmp/ws", "../escape.ts");
      expect.unreachable("resolveWithin should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafePathError);
      expect((error as UnsafePathError).path).toBe("../escape.ts");
      expect((error as UnsafePathError).name).toBe("UnsafePathError");
    }
  });

  it("rejects a sibling directory that merely shares the base's prefix", () => {
    // `/tmp/ws-evil` starts with `/tmp/ws` as a string but is not inside it.
    expect(() => resolveWithin("/tmp/ws", "..%2Fws-evil/x.ts")).not.toThrow();
    expect(resolveWithin("/tmp/ws", "..%2Fws-evil/x.ts").startsWith(join("/tmp/ws") + "/")).toBe(
      true,
    );
  });

  it("resolves the base directory itself", () => {
    expect(resolveWithin("/tmp/ws", ".")).toBe("/tmp/ws");
  });
});

describe("isProbablyBinary", () => {
  it("treats content with a NUL byte as binary", () => {
    expect(isProbablyBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it("treats plain text as not binary", () => {
    expect(isProbablyBinary(Buffer.from("const a = 1;\n", "utf8"))).toBe(false);
  });

  it("only inspects the first 8 KiB", () => {
    const data = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);

    expect(isProbablyBinary(data)).toBe(false);
  });
});

describe("isGeneratedOrVendored", () => {
  it.each([
    "node_modules/left-pad/index.js",
    "vendor/lib.ts",
    "dist/bundle.js",
    "build/out.js",
    "app/bundle.min.js",
    "src/schema.generated.ts",
    "types/index.d.ts",
  ])("skips %s", (path) => {
    expect(isGeneratedOrVendored(path)).toBe(true);
  });

  it("keeps ordinary source", () => {
    expect(isGeneratedOrVendored("src/app/db.ts")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isGeneratedOrVendored("NODE_MODULES/x.js")).toBe(true);
  });
});

describe("isWithinSize", () => {
  it("accepts a file at exactly the limit", () => {
    expect(isWithinSize(MAX_FILE_BYTES)).toBe(true);
  });

  it("rejects a file over the limit", () => {
    expect(isWithinSize(MAX_FILE_BYTES + 1)).toBe(false);
  });

  it("honours a custom limit", () => {
    expect(isWithinSize(11, 10)).toBe(false);
    expect(isWithinSize(10, 10)).toBe(true);
  });
});
