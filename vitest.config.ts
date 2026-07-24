import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // No shared mutable state between files: every test file gets a fresh module registry.
    isolate: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The local dev entrypoint only calls into the app factory (covered elsewhere); running it
      // would bind a port. Type-only modules emit no executable code.
      exclude: ["src/main.ts", "src/**/*.types.ts"],
      reporter: ["text", "lcov"],
      // The non-negotiable gate from the original project: 100% line AND branch.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
