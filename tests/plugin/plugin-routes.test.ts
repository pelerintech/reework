// Plugin routes: a plugin mounts its own paths under /plugins/<name>, behind the
// API token unless it explicitly opts a path out under /open/.
import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "@reework/core";
import { authedApp, startTestAgent, testDefinition } from "../support/agent.ts";

describe("plugin routes", () => {
  it("are served under /plugins/<name> with the token", async () => {
    const list = vi.fn((c) => c.json({ items: [1] }));
    const item = vi.fn((c) => c.json({ id: c.req.param("id") }));
    const plugin = definePlugin("items", () => ({
      routes(app) {
        app.get("/list", list);
        app.get("/item/:id", item);
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const authed = authedApp(agent);

    const listed = await authed.request("/plugins/items/list");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [1] });

    const one = await authed.request("/plugins/items/item/7");
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ id: "7" });
    expect(list).toHaveBeenCalledTimes(1);

    const missing = await agent.app.request("/plugins/items/list");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const wrong = await agent.app.request("/plugins/items/list", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
