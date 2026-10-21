#!/usr/bin/env node
// Check that each publishable package's *published* manifest (package.json with
// its publishConfig overrides applied) points only at built files in dist/,
// with type declarations next to every export.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["types", "client", "core", "tui"];
const problems = [];

function targets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(targets);
  return [];
}

for (const name of PACKAGES) {
  const dir = join("packages", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const published = { ...manifest, ...manifest.publishConfig };
  const label = published.name ?? dir;
  if (published.private) problems.push(`${label}: is private`);
  if (!published.exports) problems.push(`${label}: has no exports`);
  if (!published.files?.includes("dist")) problems.push(`${label}: files does not include dist`);

  const exported = targets(published.exports);
  const bins = targets(published.bin);
  for (const target of [...exported, ...bins]) {
    if (!target.startsWith("./dist/")) problems.push(`${label}: ${target} is not in dist/`);
    if (!existsSync(join(dir, target))) problems.push(`${label}: ${target} is missing`);
  }
  for (const target of exported.filter((t) => t.endsWith(".js"))) {
    const types = target.replace(/\.js$/, ".d.ts");
    if (!existsSync(join(dir, types))) problems.push(`${label}: ${types} is missing`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${PACKAGES.length} packages publish only built files with types`);
