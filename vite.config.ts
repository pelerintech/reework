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
      thresholds: {
        lines: 85,
        statements: 85,
      },
    },
  },
});
