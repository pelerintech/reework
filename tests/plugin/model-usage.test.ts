// `onModelUsage` covers every model call with usage: a run's main model and a
// plugin's named model from a tool, setup or a route. Calls outside a conversation
// arrive with an agent-level context (agent store, no case store).
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, ModelUsageEvent, PluginEventContext } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";

interface Seen {
  readonly event: ModelUsageEvent;
  readonly ctx: PluginEventContext;
}

const running: TestAgent[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((agent) => agent.dispose()));
});

const KEY_ENV = "REEWORK_TEST_LLM_KEY";

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "usage-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: KEY_ENV }, modelId: "m1" },
    models: {
      helper: {
        provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: KEY_ENV },
        modelId: "helper-model",
      },
    },
    plugins,
    channels: [],
    mission: { role: "You work with a helper." },
  };
}

describe("model usage events", () => {
  it("reports run and named-model calls, agent-level outside a conversation", async () => {
    const seen: Seen[] = [];
    const observer = definePlugin("observer", () => ({
      hooks: {
        async onModelUsage(event, ctx) {
          seen.push({ event, ctx });
        },
      },
    }));
    const helper = definePlugin(
      "helper",
      () => ({
        tools: [
          defineTool({
            name: "use-helper",
            description: "Ask the helper model",
            parameters: Type.Object({}),
            execute: async (_args, ctx) =>
              (await ctx.models.complete("helper", { messages: "tool" })).text,
          }),
        ],
        async setup(ctx) {
          await ctx.models.complete("helper", { messages: "setup" });
        },
        routes(app, ctx) {
          app.post("/run", async (c) => {
            const result = await ctx.models.complete("helper", { messages: "route" });
            return c.json({ text: result.text });
          });
        },
      }),
      { models: ["helper"] },
    );
    const test = await startTestAgent(
      definition([
        { plugin: observer, config: {} },
        { plugin: helper, config: {} },
      ]),
    );
    running.push(test);
    test.model.named.helper.respond([text("tool helper"), text("route helper")]);
    test.model.respond([toolCall("use-helper"), text("done")]);
    const { id } = await test.agent.host.createConversation();

    await test.agent.host.submitInput(id, "go", { wait: true });
    const response = await test.agent.app.request("/plugins/helper/run", {
      method: "POST",
      headers: { authorization: `Bearer ${test.token}` },
    });
    expect(response.status).toBe(200);
    await eventually(() => seen.length >= 5);

    const pluginEvents = seen.filter((s) => s.event.source === "plugin");
    const runEvents = seen.filter((s) => s.event.source === "run");
    expect(pluginEvents).toHaveLength(3);
    expect(runEvents).toHaveLength(2);
    for (const { event } of pluginEvents) {
      expect(event.plugin).toBe("helper");
      expect(event.model).toBe("helper");
      expect(event.usage.totalTokens).toBeGreaterThan(0);
      expect(typeof event.at).toBe("number");
    }
    for (const { event } of runEvents) {
      expect(event.model).toBe("main");
      expect(event.conversationId).toBe(id);
      expect(event.usage.totalTokens).toBeGreaterThan(0);
    }

    const toolCallEvent = pluginEvents.find((s) => s.event.conversationId === id);
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent!.ctx.conversationId).toBe(id);
    expect(typeof toolCallEvent!.ctx.store.case.get).toBe("function");

    const agentLevel = pluginEvents.filter((s) => s.event.conversationId === undefined);
    expect(agentLevel).toHaveLength(2);
    for (const { ctx } of agentLevel) {
      expect(ctx.conversationId).toBeUndefined();
      expect(ctx.case).toBeUndefined();
      expect(ctx.files).toBeUndefined();
      expect(ctx.store.case).toBeUndefined();
      expect(typeof ctx.store.agent.get).toBe("function");
    }
  });
});
