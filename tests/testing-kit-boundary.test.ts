// The kit is a separate entry: no module of @reework/core's main entry imports the
// scripted (faux) model, and the kit runs without vitest.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "packages/core/dist");

beforeAll(async () => {
  await run("pnpm", ["--filter", "@reework/types", "--filter", "@reework/core", "build"], {
    cwd: ROOT,
  });
}, 120_000);

describe("the testing kit's boundary", () => {
  it("is not loaded by the main entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reework-boundary-"));
    const hook = join(dir, "hook.mjs");
    const out = join(dir, "resolved.json");
    writeFileSync(
      hook,
      `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const seen = [];
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); seen.push({ url: r.url, parent: context.parentURL ?? "" }); return r; } });
process.on("exit", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(seen)));
`,
    );
    await run(
      process.execPath,
      [
        "--import",
        pathToFileURL(hook).href,
        "-e",
        `await import(${JSON.stringify(pathToFileURL(join(DIST, "index.js")).href)})`,
      ],
      { cwd: ROOT },
    );
    const seen = JSON.parse(readFileSync(out, "utf8")) as { url: string; parent: string }[];
    expect(seen.some((r) => r.url.includes("packages/core/dist"))).toBe(true);
    // pi-ai's root entry re-exports its faux provider, so pi-durable loads that module
    // anyway; what reework controls is that none of its own modules import it.
    const fromReework = seen.filter(
      (r) => r.url.includes("providers/faux") && r.parent.includes("packages/core/dist"),
    );
    expect(fromReework).toEqual([]);
  });

  it("runs under node --test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reework-node-test-"));
    const file = join(dir, "kit.test.mjs");
    writeFileSync(
      file,
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestAgent, text } from ${JSON.stringify(pathToFileURL(join(DIST, "testing.js")).href)};
test("an agent answers", async () => {
  const { agent, model, dispose } = await startTestAgent({
    name: "n", model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [], channels: [], mission: { role: "r" },
  });
  model.respond([text("pong")]);
  const { id } = await agent.host.createConversation();
  const { message } = await agent.host.submitInput(id, "ping", { wait: true });
  assert.match(JSON.stringify(message), /pong/);
  await dispose();
});
`,
    );
    const { stdout } = await run(process.execPath, ["--test", file], { cwd: dir });
    expect(stdout).toContain("pass 1");
  }, 60_000);
});
