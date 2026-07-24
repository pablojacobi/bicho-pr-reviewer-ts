import { describe, expect, it } from "vitest";
import type { LanguageAdapter } from "../../src/domain/ports/languageAdapter.ts";
import {
  DEFAULT_ANALYZERS,
  GenericAdapter,
} from "../../src/infrastructure/language/genericAdapter.ts";
import { AdapterRegistry } from "../../src/infrastructure/language/registry.ts";
import { TypeScriptAdapter } from "../../src/infrastructure/language/typescriptAdapter.ts";
import { aChangedFile } from "../helpers/factories.ts";

/** A minimal stub adapter with a fixed score, for exercising {@link AdapterRegistry} selection. */
function stubAdapter(language: string, score: number): LanguageAdapter {
  return {
    language,
    score: () => score,
    inScope: () => true,
    defaultAnalyzers: () => ["x"],
    enclosingSymbol: () => null,
  };
}

describe("GenericAdapter", () => {
  // Typed as the port, not the concrete class, so calls exercise the full `LanguageAdapter` contract
  // (GenericAdapter's own `enclosingSymbol` ignores its arguments and takes none).
  const adapter: LanguageAdapter = new GenericAdapter();

  it("identifies itself as the generic language", () => {
    expect(adapter.language).toBe("generic");
  });

  describe("score", () => {
    it("scores just above zero when there are changed files", () => {
      expect(adapter.score([aChangedFile()])).toBe(0.1);
    });

    it("scores zero when there are no changed files", () => {
      expect(adapter.score([])).toBe(0.0);
    });
  });

  describe("inScope", () => {
    it("is out of scope when the file has no patch", () => {
      expect(adapter.inScope(aChangedFile({ patch: null }))).toBe(false);
    });

    it("is out of scope for an unsafe path", () => {
      expect(adapter.inScope(aChangedFile({ filename: "../evil.ts" }))).toBe(false);
    });

    it("is out of scope for a generated or vendored path", () => {
      expect(adapter.inScope(aChangedFile({ filename: "dist/bundle.ts" }))).toBe(false);
    });

    it("is in scope for an ordinary changed file", () => {
      expect(adapter.inScope(aChangedFile({ filename: "app/db.ts" }))).toBe(true);
    });
  });

  it("runs the shared default analyzers", () => {
    expect(adapter.defaultAnalyzers()).toBe(DEFAULT_ANALYZERS);
    expect(adapter.defaultAnalyzers()).toContain("semgrep");
    expect(adapter.defaultAnalyzers()).toContain("npm-audit");
  });

  it("never resolves an enclosing symbol", () => {
    expect(adapter.enclosingSymbol("app/db.ts", "const x = 1;", 1)).toBeNull();
  });
});

describe("TypeScriptAdapter", () => {
  const adapter = new TypeScriptAdapter();

  it("identifies itself as the typescript language", () => {
    expect(adapter.language).toBe("typescript");
  });

  describe("score", () => {
    it.each([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])(
      "scores 0.9 when a changed file has the %s extension",
      (extension) => {
        expect(adapter.score([aChangedFile({ filename: `app/module${extension}` })])).toBe(0.9);
      },
    );

    it("scores zero when no changed file has a recognized extension", () => {
      expect(adapter.score([aChangedFile({ filename: "README.md" })])).toBe(0.0);
    });

    it("scores zero for an empty file list", () => {
      expect(adapter.score([])).toBe(0.0);
    });
  });

  describe("inScope", () => {
    it("is out of scope when the file has no patch", () => {
      expect(adapter.inScope(aChangedFile({ patch: null }))).toBe(false);
    });

    it("is out of scope for an unsafe path", () => {
      expect(adapter.inScope(aChangedFile({ filename: "../evil.ts" }))).toBe(false);
    });

    it("is out of scope for a generated or vendored path", () => {
      expect(adapter.inScope(aChangedFile({ filename: "dist/bundle.ts" }))).toBe(false);
    });

    it("is in scope for ordinary TS source", () => {
      expect(adapter.inScope(aChangedFile({ filename: "app/db.ts" }))).toBe(true);
    });

    it.each(["package.json", "tsconfig.json", "package-lock.json"])(
      "is in scope for the %s manifest",
      (filename) => {
        expect(adapter.inScope(aChangedFile({ filename }))).toBe(true);
      },
    );

    it("is out of scope for an unrelated extension", () => {
      expect(adapter.inScope(aChangedFile({ filename: "README.md" }))).toBe(false);
    });
  });

  it("runs the shared default analyzers", () => {
    expect(adapter.defaultAnalyzers()).toBe(DEFAULT_ANALYZERS);
  });

  describe("enclosingSymbol", () => {
    // A class with one method, plus a module-level function — mirrors the Python original's fixture,
    // translated from `def`/`class` to `function`/`class`.
    const FIXTURE = `import os from "node:os";

class Orders {
  total(items) {
    const subtotal = items.reduce((a, b) => a + b, 0);
    return subtotal;
  }
}

function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
`;

    it("resolves a method nested in a class to the method name", () => {
      // Line 4 is inside Orders.total — the method (smaller span) wins over the enclosing class.
      expect(adapter.enclosingSymbol("app/orders.ts", FIXTURE, 4)).toBe("total");
    });

    it("resolves a line in a class but outside any method to the class name", () => {
      // Line 3 (`class Orders {`) is inside the class but before its method begins.
      expect(adapter.enclosingSymbol("app/orders.ts", FIXTURE, 3)).toBe("Orders");
    });

    it("resolves a top-level function declaration", () => {
      // Line 10 is inside the module-level `average` function.
      expect(adapter.enclosingSymbol("app/orders.ts", FIXTURE, 10)).toBe("average");
    });

    it("returns null for a line outside any function or class", () => {
      // Line 2 is a blank line at module scope, between the import and the class.
      expect(adapter.enclosingSymbol("app/orders.ts", FIXTURE, 2)).toBeNull();
    });

    it("returns null for a line past the end of the file", () => {
      expect(adapter.enclosingSymbol("app/orders.ts", FIXTURE, 999)).toBeNull();
    });

    it("returns null inside an anonymous default-exported function", () => {
      // `export default function () {}` is the one place JS syntax allows a function declaration
      // with no name at all (`id` is `null`), so it contributes no symbol of its own.
      const source = `export default function () {
  return 1;
}
`;
      expect(adapter.enclosingSymbol("app/anon.ts", source, 2)).toBeNull();
    });

    it("resolves the innermost of two nested function declarations", () => {
      const nested = `function outer() {
  function inner() {
    return 1;
  }
  return inner();
}
`;
      // Line 3 is inside both `inner` and `outer`; `inner` has the smaller span.
      expect(adapter.enclosingSymbol("app/nested.ts", nested, 3)).toBe("inner");
      // Line 5 is inside `outer` only — `inner`'s span already ended.
      expect(adapter.enclosingSymbol("app/nested.ts", nested, 5)).toBe("outer");
    });

    it("resolves an arrow function assigned to a const", () => {
      const source = `const add = (a, b) => {
  return a + b;
};
`;
      expect(adapter.enclosingSymbol("app/add.ts", source, 2)).toBe("add");
    });

    it("resolves a class field initialized to a function expression", () => {
      const source = `class Widget {
  count = 0;
  render = function () {
    return this.count;
  };
}
`;
      // A non-function field (`count`) is not itself a named symbol, so its line falls back to the
      // enclosing class...
      expect(adapter.enclosingSymbol("app/widget.ts", source, 2)).toBe("Widget");
      // ...while a field whose value is a function is named after the field.
      expect(adapter.enclosingSymbol("app/widget.ts", source, 3)).toBe("render");
    });

    it.each([
      ["first", "const shortFn = () => 1; const longFn = () => { return 1 + 2 + 3; };\n"],
      ["second", "const longFn = () => { return 1 + 2 + 3; }; const shortFn = () => 1;\n"],
    ])(
      "prefers the smaller of two sibling declarations sharing a line, when it comes %s",
      (_position, source) => {
        // Both declarations sit on line 1, so both "contain" it; the smaller one wins regardless of
        // which was declared first, which is what proves the resolution compares span size rather
        // than just keeping whichever candidate was found first.
        expect(adapter.enclosingSymbol("app/siblings.ts", source, 1)).toBe("shortFn");
      },
    );

    it("returns null for a non-source path without attempting to parse it", () => {
      expect(adapter.enclosingSymbol("package.json", '{"name": "x"}', 1)).toBeNull();
    });

    it("returns null for unparseable content instead of throwing", () => {
      const call = () =>
        adapter.enclosingSymbol("app/broken.ts", "function f(:\n  return 1;\n}\n", 1);
      expect(call).not.toThrow();
      expect(call()).toBeNull();
    });

    it("accounts for multi-byte characters when locating a later line", () => {
      // The comment line mixes an accented letter, a BMP symbol, and a surrogate-pair emoji before
      // the target line. Using UTF-16 code-unit offsets (matching oxc's own offsets) rather than raw
      // character or byte counts is what keeps this resolving correctly.
      const source = `// café ☃ emoji \u{1F600} line
function greet() {
  return "hi";
}
`;
      expect(adapter.enclosingSymbol("app/greet.ts", source, 3)).toBe("greet");
    });
  });
});

describe("AdapterRegistry", () => {
  const files = [aChangedFile()];

  it("selects the highest-scoring adapter", () => {
    const registry = new AdapterRegistry(
      [stubAdapter("ruby", 0.3), stubAdapter("typescript", 0.9)],
      {
        fallback: new GenericAdapter(),
      },
    );

    expect(registry.select(files).language).toBe("typescript");
  });

  it("keeps the first-registered adapter when two adapters tie", () => {
    const registry = new AdapterRegistry([stubAdapter("first", 0.9), stubAdapter("second", 0.9)], {
      fallback: new GenericAdapter(),
    });

    expect(registry.select(files).language).toBe("first");
  });

  it("falls back when no adapter scores above zero", () => {
    const registry = new AdapterRegistry([stubAdapter("ruby", 0.0)], {
      fallback: new GenericAdapter(),
    });

    expect(registry.select(files).language).toBe("generic");
  });
});
