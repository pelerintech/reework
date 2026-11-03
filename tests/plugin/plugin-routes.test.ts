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

describe("plugin routes: open paths", () => {
  it("serve /open/ without the token and warn at startup", async () => {
    const inbound = vi.fn((c) => c.json({ ok: true }));
    const other = vi.fn((c) => c.json({ ok: true }));
    const items = definePlugin("items", () => ({
      routes(app) {
        app.get("/list", (c) => c.json({ items: [] }));
      },
    }));
    const hookin = definePlugin("hookin", () => ({
      routes(app) {
        app.post("/open/inbound", inbound);
        app.get("/other", other);
      },
    }));

    const warnings: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args) => warnings.push(args));
    const agent = await startTestAgent(
      testDefinition({
        plugins: [
          { plugin: items, config: {} },
          { plugin: hookin, config: {} },
        ],
      }),
    );
    spy.mockRestore();

    const open = await agent.app.request("/plugins/hookin/open/inbound", { method: "POST" });
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ ok: true });
    expect(inbound).toHaveBeenCalledTimes(1);

    const guarded = await agent.app.request("/plugins/hookin/other");
    expect(guarded.status).toBe(401);
    expect(await guarded.json()).toEqual({ error: "unauthorized" });
    expect(other).not.toHaveBeenCalled();

    const logged = warnings.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain('plugin "hookin"');
    expect(logged).toContain("/plugins/hookin/open/");
    expect(logged).not.toContain('plugin "items"');
  });
});
