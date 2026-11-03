// Plugin route startup checks: unsafe names, throwing routes, and agent routes
// trying to mount under the plugin prefix all fail before the agent serves.
import { describe, expect, it } from "vitest";
import { definePlugin, startAgent } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { fauxModels, startTestAgent, tmpStorage, untrack } from "../support/agent.ts";

function definition(
  plugins: AgentDefinition["plugins"],
  routes?: AgentDefinition["routes"],
): AgentDefinition {
  return {
    name: "routes-startup-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You start." },
    ...(routes ? { routes } : {}),
  };
}

function start(
  plugins: AgentDefinition["plugins"],
  storagePath: string,
  routes?: AgentDefinition["routes"],
) {
  return startAgent(definition(plugins, routes), {
    storagePath,
    models: fauxModels("m1").models,
    auth: { token: "routes-token" },
  });
}

/** Start, expecting a rejection; if it unexpectedly starts, stop it and fail. */
async function startFailure(
  plugins: AgentDefinition["plugins"],
  storagePath: string,
  routes?: AgentDefinition["routes"],
): Promise<Error> {
  let running;
  try {
    running = await start(plugins, storagePath, routes);
  } catch (error) {
    return error as Error;
  }
  await running.stop();
  throw new Error("startAgent unexpectedly succeeded");
}

function firstPlugin() {
  const seen = { stops: 0 };
  const plugin = definePlugin("a", () => ({
    stop() {
      seen.stops += 1;
    },
  }));
  return { plugin, seen };
}

async function restarts(storagePath: string) {
  const next = await startTestAgent(definition([]), { storagePath });
  await next.stop();
  untrack(next);
}

describe("plugin routes: startup checks", () => {
  it("refuses a plugin with routes whose name is not URL-safe", async () => {
    const a = firstPlugin();
    const invalid = definePlugin("My Items", () => ({
      routes(app) {
        app.get("/x", (c) => c.json({ ok: true }));
      },
    }));
    const storagePath = tmpStorage();

    const error = await startFailure(
      [
        { plugin: a.plugin, config: {} },
        { plugin: invalid, config: {} },
      ],
      storagePath,
    );
    expect(error.message).toContain("has routes but its name is not URL-safe");
    expect(a.seen.stops).toBe(1);
    await restarts(storagePath);
  });

  it("refuses a plugin whose routes throw, naming the plugin", async () => {
    const a = firstPlugin();
    const throwing = definePlugin("b", () => ({
      routes() {
        throw new Error("nope");
      },
    }));
    const storagePath = tmpStorage();

    const error = await startFailure(
      [
        { plugin: a.plugin, config: {} },
        { plugin: throwing, config: {} },
      ],
      storagePath,
    );
    expect(error.message).toContain('plugin "b" routes failed: nope');
    expect(a.seen.stops).toBe(1);
    await restarts(storagePath);
  });

  it("refuses agent routes that mount under /plugins/", async () => {
    const a = firstPlugin();
    const storagePath = tmpStorage();

    const error = await startFailure([{ plugin: a.plugin, config: {} }], storagePath, (app) =>
      app.get("/plugins/x/y", (c) => c.json({ ok: true })),
    );
    expect(error.message).toContain("agent routes may not use the /plugins/ prefix");
    expect(a.seen.stops).toBe(1);
    await restarts(storagePath);
  });

  it("keeps agent routes outside /plugins/ unauthenticated", async () => {
    const storagePath = tmpStorage();
    const agent = await startTestAgent(
      definition([], (app) => app.get("/webhook", (c) => c.json({ ok: true }))),
      { storagePath },
    );
    const response = await agent.app.request("/webhook");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await agent.stop();
    untrack(agent);
  });
});
