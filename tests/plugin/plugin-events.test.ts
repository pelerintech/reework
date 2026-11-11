// Plugin events: one plugin announces its own moment with `ctx.emit`, and every
// other plugin that provides `onPluginEvent` receives it through the same queued
// event delivery as the host's event hooks.
import { describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition, PluginEvent, PluginEventContext } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";

interface Seen {
  readonly event: PluginEvent;
  readonly ctx: PluginEventContext;
}

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "event-agent",
    model: {
      provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" },
      modelId: "m1",
    },
    plugins,
    channels: [],
    mission: { role: "You answer." },
  };
}

describe("plugin events", () => {
  it("delivers an emitted event to other plugins with the emitter and conversation", async () => {
    const seen: Seen[] = [];
    const emitter = definePlugin("a", () => ({
      tools: [
        defineTool({
          name: "warn",
          description: "Announce a budget warning.",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            ctx.emit("budget.warning", { used: 90 });
            return "announced";
          },
        }),
      ],
    }));
    const consumer = definePlugin("b", () => ({
      hooks: {
        async onPluginEvent(event, ctx) {
          seen.push({ event, ctx });
        },
      },
    }));

    const test = await startTestAgent(
      definition([
        { plugin: emitter, config: {} },
        { plugin: consumer, config: {} },
      ]),
    );
    test.model.respond([toolCall("warn"), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go");

    const delivered = await eventually(() => seen[0]);
    expect(delivered.event).toMatchObject({
      name: "budget.warning",
      data: { used: 90 },
      plugin: "a",
      conversationId: id,
    });
    expect(delivered.ctx.conversationId).toBe(id);

    await test.dispose();
  });

  it("does not deliver an event back to the plugin that emitted it", async () => {
    const own: PluginEvent[] = [];
    const other: PluginEvent[] = [];
    const emitter = definePlugin("a", () => ({
      tools: [
        defineTool({
          name: "warn",
          description: "Announce a budget warning.",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            ctx.emit("budget.warning", { used: 90 });
            return "announced";
          },
        }),
      ],
      hooks: {
        async onPluginEvent(event) {
          own.push(event);
        },
      },
    }));
    const consumer = definePlugin("b", () => ({
      hooks: {
        async onPluginEvent(event) {
          other.push(event);
        },
      },
    }));

    const test = await startTestAgent(
      definition([
        { plugin: emitter, config: {} },
        { plugin: consumer, config: {} },
      ]),
    );
    test.model.respond([toolCall("warn"), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go");

    const delivered = await eventually(() => other[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered.plugin).toBe("a");
    expect(delivered.conversationId).toBe(id);
    expect(own).toEqual([]);

    await test.dispose();
  });

  it("delivers setup and route events agent-level, with no conversation", async () => {
    const seen: Seen[] = [];
    const setupEmitter = definePlugin("setup-emitter", () => ({
      setup(ctx) {
        ctx.emit("setup.ready", { ok: true });
      },
    }));
    const routeEmitter = definePlugin("route-emitter", () => ({
      routes(app, ctx) {
        app.post("/emit", (c) => {
          ctx.emit("route.hit", { path: c.req.path });
          return c.json({ ok: true });
        });
      },
    }));
    const consumer = definePlugin("b", () => ({
      hooks: {
        async onPluginEvent(event, ctx) {
          seen.push({ event, ctx });
        },
      },
    }));

    const test = await startTestAgent(
      definition([
        { plugin: setupEmitter, config: {} },
        { plugin: routeEmitter, config: {} },
        { plugin: consumer, config: {} },
      ]),
    );

    const setupSeen = await eventually(() => seen.find((s) => s.event.name === "setup.ready")!);
    expect(setupSeen.event).toMatchObject({
      name: "setup.ready",
      data: { ok: true },
      plugin: "setup-emitter",
    });
    expect(setupSeen.event.conversationId).toBeUndefined();
    expect(setupSeen.ctx.conversationId).toBeUndefined();
    expect(setupSeen.ctx.files).toBeUndefined();
    expect(setupSeen.ctx.case).toBeUndefined();
    expect(setupSeen.ctx.store.case).toBeUndefined();
    expect(typeof setupSeen.ctx.store.agent.get).toBe("function");

    const response = await test.agent.app.request("/plugins/route-emitter/emit", {
      method: "POST",
      headers: { authorization: `Bearer ${test.token}` },
    });
    expect(response.status).toBe(200);
    const routeSeen = await eventually(() => seen.find((s) => s.event.name === "route.hit")!);
    expect(routeSeen.event).toMatchObject({ name: "route.hit", plugin: "route-emitter" });
    expect(routeSeen.event.conversationId).toBeUndefined();
    expect(routeSeen.ctx.conversationId).toBeUndefined();
    expect(routeSeen.ctx.files).toBeUndefined();
    expect(routeSeen.ctx.case).toBeUndefined();
    expect(routeSeen.ctx.store.case).toBeUndefined();

    await test.dispose();
  });

  it("queues tool emits post-commit, without delaying the caller, in emit order", async () => {
    let executeReturned = false;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const committedAtReceive: boolean[] = [];
    const emitter = definePlugin("a", () => ({
      tools: [
        defineTool({
          name: "announce",
          description: "Announce two events.",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            ctx.emit("first", { n: 1 });
            ctx.emit("second", { n: 2 });
            await new Promise((resolve) => setTimeout(resolve, 150));
            executeReturned = true;
            return "done";
          },
        }),
      ],
    }));
    const consumer = definePlugin("b", () => ({
      hooks: {
        async onPluginEvent(event) {
          committedAtReceive.push(executeReturned);
          order.push(event.name);
          if (event.name === "first") await deferred;
        },
      },
    }));

    const test = await startTestAgent(
      definition([
        { plugin: emitter, config: {} },
        { plugin: consumer, config: {} },
      ]),
    );
    test.model.respond([toolCall("announce"), text("done")]);
    const { id } = await test.agent.host.createConversation();

    const begun = Date.now();
    await test.agent.host.submitInput(id, "go");
    expect(Date.now() - begun).toBeLessThan(150);

    await eventually(() => order[0]);
    expect(committedAtReceive).toEqual([true]);
    release();
    await eventually(() => order.length === 2);
    expect(order).toEqual(["first", "second"]);
    expect(committedAtReceive).toEqual([true, true]);

    await test.dispose();
  });
});
