// Plugin lifecycle: any startup failure after a plugin was built stops the plugins
// already built, so a factory's connection or a setup's loop does not leak.
import { describe, expect, it } from "vitest";
import { definePlugin, startAgent } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { fauxModels, startTestAgent, tmpStorage, untrack } from "../support/agent.ts";

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "startup-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You start." },
  };
}

/** Start on `storagePath` with a token and faux models; a startup failure rejects. */
function start(plugins: AgentDefinition["plugins"], storagePath: string) {
  return startAgent(definition(plugins), {
    storagePath,
    models: fauxModels("m1").models,
    auth: { token: "startup-token" },
  });
}

/** A plugin "a" that records its setup (and its signal) and how often its stop ran. */
function firstPlugin() {
  const seen = { setupRan: false, signal: undefined as AbortSignal | undefined, stops: 0 };
  const plugin = definePlugin("a", () => ({
    setup(ctx) {
      seen.setupRan = true;
      seen.signal = ctx.signal;
    },
    stop() {
      seen.stops += 1;
    },
  }));
  return { plugin, seen };
}

describe("plugin lifecycle: failed startup", () => {
  it("stops built plugins when a later setup throws", async () => {
    const a = firstPlugin();
    const b = definePlugin("b", () => ({
      setup() {
        throw new Error("nope");
      },
    }));
    const storagePath = tmpStorage();

    await expect(
      start(
        [
          { plugin: a.plugin, config: {} },
          { plugin: b, config: {} },
        ],
        storagePath,
      ),
    ).rejects.toThrow(/plugin "b" setup failed: nope/);

    expect(a.seen.setupRan).toBe(true);
    expect(a.seen.signal?.aborted).toBe(true);
    expect(a.seen.stops).toBe(1);

    const next = await startTestAgent(definition([]), { storagePath });
    await next.stop();
    untrack(next);
  });

  it("stops built plugins when a later factory throws", async () => {
    const a = firstPlugin();
    const b = definePlugin("b", () => {
      throw new Error("cannot build");
    });
    const storagePath = tmpStorage();

    await expect(
      start(
        [
          { plugin: a.plugin, config: {} },
          { plugin: b, config: {} },
        ],
        storagePath,
      ),
    ).rejects.toThrow(/plugin "b" failed: cannot build/);

    expect(a.seen.setupRan).toBe(false);
    expect(a.seen.stops).toBe(1);

    const next = await startTestAgent(definition([]), { storagePath });
    await next.stop();
    untrack(next);
  });

  it("stops built plugins when validation fails after build", async () => {
    const a = firstPlugin();
    const b = definePlugin("b", () => ({}), { models: ["vision"] });
    const storagePath = tmpStorage();

    await expect(
      start(
        [
          { plugin: a.plugin, config: {} },
          { plugin: b, config: {} },
        ],
        storagePath,
      ),
    ).rejects.toThrow(/"vision"/);

    expect(a.seen.stops).toBe(1);

    const next = await startTestAgent(definition([]), { storagePath });
    await next.stop();
    untrack(next);
  });
});
