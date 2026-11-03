// Plugin data directories: one persistent directory per plugin that has setup or
// routes, beside the agent's storage file, and nothing for a tools-only plugin.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent as startTestingAgent } from "@reework/core/testing";
import {
  authedApp,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "../support/agent.ts";

interface Seen {
  dir?: string;
  existed?: boolean;
  content?: string;
}

function pluginA(seen: Seen) {
  return definePlugin("a", () => ({
    setup(ctx) {
      seen.dir = ctx.dataDir;
      seen.existed = existsSync(ctx.dataDir);
      const file = join(ctx.dataDir, "x.txt");
      seen.content = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      writeFileSync(file, "kept");
    },
  }));
}

const pluginB = definePlugin("b", () => ({
  routes(app, ctx) {
    app.get("/dir", (c) => c.json({ dataDir: ctx.dataDir }));
  },
}));

const pluginC = definePlugin("c", () => ({
  tools: [
    defineTool({
      name: "noop",
      description: "Do nothing",
      parameters: Type.Object({}),
      execute: async () => "ok",
    }),
  ],
}));

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return testDefinition({ plugins });
}

describe("plugin data directories", () => {
  it("sit beside the storage, exist before setup, persist, and skip tools-only plugins", async () => {
    const storagePath = tmpStorage();
    const seen: Seen = {};
    const first = await startTestAgent(
      definition([
        { plugin: pluginA(seen), config: {} },
        { plugin: pluginB, config: {} },
        { plugin: pluginC, config: {} },
      ]),
      { storagePath },
    );

    const expectedA = `${storagePath}.plugins/a`;
    const expectedB = `${storagePath}.plugins/b`;
    expect(seen.dir).toBe(expectedA);
    expect(seen.existed).toBe(true);
    expect(existsSync(join(expectedA, "x.txt"))).toBe(true);

    const dir = await authedApp(first).request("/plugins/b/dir");
    expect(dir.status).toBe(200);
    expect(await dir.json()).toEqual({ dataDir: expectedB });

    expect(existsSync(`${storagePath}.plugins/c`)).toBe(false);
    await first.stop();
    untrack(first);

    const restarted: Seen = {};
    const second = await startTestAgent(definition([{ plugin: pluginA(restarted), config: {} }]), {
      storagePath,
    });
    expect(restarted.dir).toBe(expectedA);
    expect(restarted.existed).toBe(true);
    expect(restarted.content).toBe("kept");
    expect(existsSync(join(expectedA, "x.txt"))).toBe(true);
    await second.stop();
    untrack(second);
  });

  it("are removed with temporary storage by startTestAgent dispose", async () => {
    const seen: Seen = {};
    const test = await startTestingAgent(definition([{ plugin: pluginA(seen), config: {} }]));
    const dir = seen.dir!;
    expect(existsSync(dir)).toBe(true);
    await test.dispose();
    expect(existsSync(dir)).toBe(false);
  });
});
