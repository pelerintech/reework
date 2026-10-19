import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startAgent } from "@reework/core";
import type { AgentDefinition } from "@reework/core";

const agents: Awaited<ReturnType<typeof startAgent>>[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

interface PluginInit {
  engine: unknown;
  config: { note: string };
}

describe("startAgent boots an agent from a definition", () => {
  it("installs declared plugins with their config and starts a reachable server", async () => {
    const inits: PluginInit[] = [];
    const stubPlugin = {
      init(engine: unknown, config: { note: string }) {
        inits.push({ engine, config });
      },
    };

    const agent: AgentDefinition = {
      name: "oncall",
      model: { provider: { baseUrl: "u", apiKey: "k" }, modelId: "m" },
      plugins: [{ plugin: stubPlugin, config: { note: "hello" } }],
      channels: [],
      mission: { role: "r", tools: [] },
    };

    const running = await startAgent(agent, { storagePath: tmpPath() });
    agents.push(running);

    // The plugin was initialized with its declared config and a real engine.
    expect(inits).toHaveLength(1);
    expect(inits[0].config).toEqual({ note: "hello" });
    expect(inits[0].engine).toBeDefined();

    // The server is reachable via its app.
    const health = await running.app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it("stop() closes the engine and shuts down cleanly", async () => {
    const agent: AgentDefinition = {
      name: "oncall",
      model: { provider: { baseUrl: "u", apiKey: "k" }, modelId: "m" },
      plugins: [],
      channels: [],
      mission: { role: "r", tools: [] },
    };

    const running = await startAgent(agent, { storagePath: tmpPath() });

    // The engine is open and usable before stop.
    expect(running.engine).toBeDefined();

    await expect(running.stop()).resolves.toBeUndefined();

    // After stop, the engine is closed (a subsequent commit rejects).
    await expect(running.engine.commit(() => ({}))).rejects.toBeTruthy();
  });

  it("installs declared channels with their config, wiring them at init", async () => {
    const channelInits: { engine: unknown; config: { number: string } }[] = [];
    const stubChannel = {
      init(engine: unknown, config: { number: string }) {
        channelInits.push({ engine, config });
      },
    };

    const agent: AgentDefinition = {
      name: "oncall",
      model: { provider: { baseUrl: "u", apiKey: "k" }, modelId: "m" },
      plugins: [],
      channels: [{ plugin: stubChannel, config: { number: "+1555" } }],
      mission: { role: "r", tools: [] },
    };

    const running = await startAgent(agent, { storagePath: tmpPath() });
    agents.push(running);

    // The channel was wired at init with its declared config and a real engine.
    expect(channelInits).toHaveLength(1);
    expect(channelInits[0].config).toEqual({ number: "+1555" });
    expect(channelInits[0].engine).toBeDefined();

    // The server is still reachable.
    const health = await running.app.request("/health");
    expect(health.status).toBe(200);
  });
});
