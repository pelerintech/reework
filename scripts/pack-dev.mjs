#!/usr/bin/env node
// pack:dev — build and pack the four packages with a unique prerelease version
// (`<version>-dev.<UTC stamp>.<short sha>`), so a consumer installing from tarballs
// always sees a new version and never keeps an old build. Internal dependencies are
// pinned to the same version (pnpm rewrites `workspace:*` at pack time). The repo's
// manifests are restored afterwards, even on failure.
//
//   pnpm pack:dev --out <dir> [--skip-build]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = ["types", "client", "core", "tui"];
const { values } = parseArgs({
  options: { out: { type: "string" }, "skip-build": { type: "boolean", default: false } },
});
if (!values.out) {
  console.error("usage: pnpm pack:dev --out <dir> [--skip-build]");
  process.exit(1);
}
const out = resolve(process.cwd(), values.out);
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
const base = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")).version;
const version = `${base.split("-")[0]}-dev.${stamp}.${sha}`;

if (!values["skip-build"]) run("pnpm", ["-r", "--filter", "./packages/*", "build"], ROOT);
mkdirSync(out, { recursive: true });

const manifests = PACKAGES.map((name) => join(ROOT, "packages", name, "package.json"));
const originals = manifests.map((path) => readFileSync(path, "utf8"));
try {
  manifests.forEach((path, i) => {
    const manifest = JSON.parse(originals[i]);
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  for (const name of PACKAGES) {
    run("pnpm", ["pack", "--pack-destination", out], join(ROOT, "packages", name));
  }
} finally {
  manifests.forEach((path, i) => writeFileSync(path, originals[i]));
}
console.log(`pack:dev: ${version} → ${out}`);
