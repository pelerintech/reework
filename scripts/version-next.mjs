#!/usr/bin/env node
// Stamp every publishable package to one prerelease id: `<base>-next.<id>`, where
// `<base>` is the current version without any prerelease part. Only `version`
// fields are rewritten — no git operations, and `.release-please-manifest.json`
// is untouched. Internal dependencies stay `workspace:*`, which pnpm replaces with
// the exact version at pack/publish time.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["types", "client", "core", "tui"];
const VALID_ID = /^[0-9A-Za-z-]+$/;

function parseArgs(argv) {
  let id;
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[i + 1];
      i += 1;
      continue;
    }
    if (id === undefined) {
      id = arg;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return { id, root };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`version-next: ${error.message}`);
  process.exit(1);
}

const { id, root } = parsed;
if (id === undefined || !VALID_ID.test(id)) {
  console.error("usage: version-next <id> [--root <dir>] (id must match ^[0-9A-Za-z-]+$)");
  process.exit(1);
}

for (const name of PACKAGES) {
  const path = join(root, "packages", name, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const base = String(manifest.version).split("-")[0];
  manifest.version = `${base}-next.${id}`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
