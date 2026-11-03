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

describe("plugin routes: context", () => {
  it("give handlers the plugin's context after setup", async () => {
    const plugin = definePlugin("items", () => ({
      setup(ctx) {
        return ctx.store.agent.set("ready", "yes");
      },
      routes(app, ctx) {
        app.get("/ctx", async (c) =>
          c.json({
            ready: await ctx.store.agent.get("ready"),
            config: ctx.config,
            aborted: ctx.signal.aborted,
            hasDataDir: typeof ctx.dataDir === "string",
          }),
        );
        app.post("/conv", async (c) => c.json(await ctx.host.createConversation({ key: "k1" })));
      },
    }));
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin, config: { mode: "declared" } }] }),
    );
    const authed = authedApp(agent);

    const context = await authed.request("/plugins/items/ctx");
    expect(context.status).toBe(200);
    expect(await context.json()).toEqual({
      ready: "yes",
      config: { mode: "declared" },
      aborted: false,
      hasDataDir: true,
    });

    const created = await authed.request("/plugins/items/conv", { method: "POST" });
    expect(created.status).toBe(200);
    const conversation = (await created.json()) as { id: string };
    expect((await agent.host.listConversations()).map((c) => c.id)).toContain(conversation.id);
  });
});

describe("plugin routes: errors", () => {
  it("contain a thrown handler error and map protocol errors first", async () => {
    const plugin = definePlugin("items", () => ({
      routes(app, ctx) {
        app.get("/boom", () => {
          throw new Error("broken");
        });
        app.get("/missing", async (c) => c.json(await ctx.host.getCase("nope")));
      },
    }));
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const authed = authedApp(agent);

    const boom = await authed.request("/plugins/items/boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "plugin_error", plugin: "items" });

    const missing = await authed.request("/plugins/items/missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "conversation_not_found",
      conversationId: "nope",
    });
    spy.mockRestore();

    const logged = errors.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain('plugin "items" route failed');
    expect(logged).toContain("broken");
  });
});
