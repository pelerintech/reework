// `version-next` stamps every publishable package to one prerelease id, replacing any
// earlier prerelease part and touching nothing else.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const PACKAGES = ["types", "client", "core", "tui"];

/** A temp workspace shaped like the repo: each package manifest plus the release manifest. */
function fixture(): { root: string; manifests: string[]; manifest: string } {
  const root = mkdtempSync(join(tmpdir(), "reework-next-"));
  const manifests = PACKAGES.map((name) => {
    const dir = join(root, "packages", name);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "package.json");
    writeFileSync(target, readFileSync(`packages/${name}/package.json`));
    return target;
  });
  const manifest = join(root, ".release-please-manifest.json");
  writeFileSync(manifest, readFileSync(".release-please-manifest.json"));
  return { root, manifests, manifest };
}

const versionOf = (path: string): string =>
  (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;

/** The version without any prerelease part, which `version-next` keeps as its base. */
const baseOf = (version: string): string => version.split("-")[0] ?? version;

const internalDeps = (path: string): Record<string, string> => {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = manifest.dependencies ?? {};
  return Object.fromEntries(Object.entries(deps).filter(([name]) => name.startsWith("@reework/")));
};

describe("scripts/version-next.mjs", () => {
  it("stamps every publishable package, keeping workspace deps and the manifest", async () => {
    const { root, manifests, manifest } = fixture();
    const manifestBefore = readFileSync(manifest, "utf8");
    const realBefore = PACKAGES.map((name) => versionOf(`packages/${name}/package.json`));
    const bases = realBefore.map(baseOf);

    await run("node", ["scripts/version-next.mjs", "7", "--root", root]);

    manifests.forEach((path, index) => expect(versionOf(path)).toBe(`${bases[index]}-next.7`));
    for (const path of manifests) {
      for (const spec of Object.values(internalDeps(path))) expect(spec).toBe("workspace:*");
    }
    expect(readFileSync(manifest, "utf8")).toBe(manifestBefore);
    expect(PACKAGES.map((name) => versionOf(`packages/${name}/package.json`))).toEqual(realBefore);

    await run("node", ["scripts/version-next.mjs", "8", "--root", root]);
    manifests.forEach((path, index) => expect(versionOf(path)).toBe(`${bases[index]}-next.8`));
  }, 20_000);

  it("refuses an id that is not a plain identifier", async () => {
    const { root, manifests } = fixture();
    const before = manifests.map(versionOf);

    await expect(
      run("node", ["scripts/version-next.mjs", "a b", "--root", root]),
    ).rejects.toThrow();
    expect(manifests.map(versionOf)).toEqual(before);

    await expect(run("node", ["scripts/version-next.mjs", "", "--root", root])).rejects.toThrow();
    expect(manifests.map(versionOf)).toEqual(before);
  }, 20_000);
});
