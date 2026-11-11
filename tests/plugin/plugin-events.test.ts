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
});
