import { defineConfig } from "vite-plus";

export default defineConfig({
  check: {
    fmt: true,
    lint: true,
  },
  lint: {
    ignorePatterns: ["dist/**", "coverage/**", "node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      // Terminal/UI rendering components are the Playwright E2E surface, not
      // the unit-coverage gate; the protocol client they consume is covered.
      exclude: ["packages/*/src/**/*.tsx"],
      thresholds: {
        lines: 85,
        statements: 85,
      },
    },
  },
});
