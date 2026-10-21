import { defaultServerConditions, defineConfig } from "vite-plus";

// Workspace packages export a `reework-source` condition pointing at src/, so tests run
// against source without a build; published manifests (publishConfig) drop it.
const conditions = ["reework-source", ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  check: {
    fmt: true,
    lint: true,
  },
  lint: {
    ignorePatterns: ["**/dist/**", "coverage/**", "node_modules/**"],
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
      // The CLI entry runs in a child process (tests/cli.test.ts), out of v8's reach.
      exclude: ["packages/*/src/**/*.tsx", "packages/core/src/cli.ts"],
      thresholds: {
        lines: 85,
        statements: 85,
      },
    },
  },
});
