// The docs' plugin examples are part of the contract: every checked TypeScript
// block must compile against the built `@reework/core` declarations.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "packages/core/dist");

interface CodeBlock {
  readonly info: string;
  readonly code: string;
}

/** Every fenced block in a markdown document, with its fence info string. */
function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let info = "";
  let lines: string[] | undefined;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      if (lines === undefined) {
        info = line.slice(3).trim();
        lines = [];
      } else {
        blocks.push({ info, code: lines.join("\n") });
        lines = undefined;
      }
    } else if (lines !== undefined) {
      lines.push(line);
    }
  }
  return blocks;
}

/** TypeScript examples the test checks; `fragment` marks an intentional fragment. */
function checkedExamples(markdown: string): CodeBlock[] {
  return codeBlocks(markdown).filter(
    (b) => /^(ts|typescript)\b/.test(b.info) && !/\b(fragment|no-check)\b/.test(b.info),
  );
}

beforeAll(async () => {
  await run("pnpm", ["--filter", "@reework/types", "--filter", "@reework/core", "build"], {
    cwd: ROOT,
  });
}, 120_000);

describe("docs examples", () => {
  it("compile against the built @reework/core contract", async () => {
    const markdown = readFileSync(join(ROOT, "docs/plugins.md"), "utf8");
    const examples = checkedExamples(markdown);
    expect(examples.length).toBeGreaterThanOrEqual(2);

    const dir = mkdtempSync(join(tmpdir(), "reework-docs-"));
    const files = examples.map((example, i) => {
      const file = join(dir, `example-${i}.ts`);
      writeFileSync(file, example.code);
      return file;
    });
    const tsconfig = join(dir, "tsconfig.json");
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
          paths: { "@reework/core": [join(DIST, "index.d.ts")] },
          baseUrl: ".",
        },
        include: files,
      }),
    );
    await run(resolve(ROOT, "node_modules/.bin/tsc"), ["--noEmit", "-p", tsconfig], { cwd: ROOT });
  }, 30_000);
});
