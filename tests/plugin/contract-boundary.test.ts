// The main entry leaks no framework internals: `Engine`, the storage seam, the
// extension/toExtension converter, the once helpers and the HITL task internals
// are exported from `@reework/core/internal`, not from `@reework/core`, and a
// plugin typed against the built `dist` needs only `@reework/core`.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "packages/core/dist");

/** Symbols that live in `@reework/core/internal`, not the main entry. */
const INTERNALS = [
  "Engine",
  "CONTEXT",
  "StorageSeam",
  "toExtension",
  "onceInCommit",
  "GateTask",
  "installHITL",
  "settleGate",
];

beforeAll(async () => {
  await run("pnpm", ["--filter", "@reework/types", "--filter", "@reework/core", "build"], {
    cwd: ROOT,
  });
}, 120_000);

async function exportedNames(mod: string): Promise<string[]> {
  const { stdout } = await run(
    process.execPath,
    ["-e", `import * as m from ${JSON.stringify(mod)}; console.log(Object.keys(m).join("\\n"))`],
    { cwd: ROOT },
  );
  return stdout.split("\n").filter(Boolean);
}

describe("the main entry leaks no internals", () => {
  it("does not export the internals, and `./internal` does", async () => {
    const indexExports = await exportedNames(join(DIST, "index.js"));
    const internalExports = await exportedNames(join(DIST, "internal.js"));
    for (const name of INTERNALS) {
      expect(indexExports).not.toContain(name);
      expect(internalExports).toContain(name);
    }
  });

  it("does not name the internals in the main entry's declarations", () => {
    const dts = readFileSync(join(DIST, "index.d.ts"), "utf8");
    for (const name of INTERNALS) {
      expect(dts.split(name).length - 1).toBeLessThanOrEqual(0);
    }
  });

  it("type-checks a plugin against the built dist using only @reework/core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reework-contract-"));
    const tsconfig = join(dir, "tsconfig.json");
    // Resolve @reework/core to the built package (no reework-source), so the
    // fixture compiles against the published declarations only.
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          paths: { "@reework/core": [join(ROOT, "packages/core/dist/index.d.ts")] },
          baseUrl: ".",
        },
        include: [join(ROOT, "tests/plugin/fixtures/contract-plugin.ts")],
      }),
    );
    await run(resolve(ROOT, "node_modules/.bin/tsc"), ["--noEmit", "-p", tsconfig], { cwd: ROOT });
  }, 30_000);
});
