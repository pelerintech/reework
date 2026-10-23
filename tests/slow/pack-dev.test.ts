// pack:dev gives every pack a fresh prerelease version, so a consumer installing
// from tarballs always gets the new build, and it leaves the repo untouched.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");

async function manifestOf(tarball: string): Promise<Record<string, any>> {
  const { stdout } = await run("tar", ["-xOzf", tarball, "package/package.json"]);
  return JSON.parse(stdout);
}

async function pack(extra: string[] = []) {
  const out = mkdtempSync(join(tmpdir(), "reework-pack-dev-"));
  await run("pnpm", ["pack:dev", "--out", out, ...extra], { cwd: ROOT });
  const files = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  return Promise.all(files.map((f) => manifestOf(join(out, f))));
}

describe("pnpm pack:dev", () => {
  it("stamps a new version each time, pins internal deps to it, and restores the repo", async () => {
    const manifests = () =>
      ["types", "client", "core", "tui"].map((n) =>
        readFileSync(join(ROOT, "packages", n, "package.json"), "utf8"),
      );
    const before = manifests();
    const first = await pack();
    const second = await pack(["--skip-build"]);
    expect(first.map((m) => m.name as string).sort((a, b) => a.localeCompare(b))).toEqual([
      "@reework/client",
      "@reework/core",
      "@reework/tui",
      "@reework/types",
    ]);
    const version = first[0].version as string;
    expect(version).toMatch(/-dev\.\d+\.[0-9a-f]+/);
    expect(new Set(first.map((m) => m.version))).toEqual(new Set([version]));
    expect(second[0].version).not.toBe(version);
    const core = first.find((m) => m.name === "@reework/core")!;
    expect(core.dependencies["@reework/types"]).toBe(version);

    expect(manifests()).toEqual(before);
  }, 300_000);
});
