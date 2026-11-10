// Event hooks get the plugin's real store: what they keep per case is read back by later
// hooks and the plugin's tools, and stays inside that case.
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";

const running: TestAgent[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((agent) => agent.dispose()));
});

function definition(plugin: ReturnType<typeof definePlugin>): AgentDefinition {
  return {
    name: "event-store",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "r" },
  };
}

describe("plugin store in event hooks", () => {
  it("keeps case state from onInput and onCaseClosed that tools read back, per case", async () => {
    const closed: Record<string, unknown> = {};
    const toolReads: unknown[] = [];
    const plugin = definePlugin("notes", () => ({
      tools: [
        defineTool({
          name: "read_inputs",
          description: "read the inputs seen in this case",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            toolReads.push((await ctx.store.case.get("inputs")) ?? null);
            return "ok";
          },
        }),
      ],
      hooks: {
        async onInput(input, ctx) {
          await ctx.store.case.update("inputs", (current) => [
            ...((current as string[] | undefined) ?? []),
            input.content,
          ]);
        },
        async onCaseClosed(_input, ctx) {
          await ctx.store.case.set("closed", true);
          closed[ctx.conversationId] = {
            inputs: await ctx.store.case.get("inputs"),
            keys: (await ctx.store.case.list("")).map((item) => item.key),
          };
        },
      },
    }));
    const test = await startTestAgent(definition(plugin));
    running.push(test);
    const host = test.agent.host;

    test.model.respond([text("one"), text("two")]);
    const a = await host.createConversation();
    const b = await host.createConversation();
    await host.submitInput(a.id, "first", { wait: true });
    await host.submitInput(b.id, "other", { wait: true });
    await host.submitInput(a.id, "second", { wait: true });

    test.model.respond([toolCall("read_inputs", {}), text("done")]);
    await eventually(async () => {
      toolReads.length = 0;
      await host.submitInput(a.id, "check", { wait: true });
      const last = toolReads.at(-1) as string[] | null;
      return last?.includes("second") ? last : undefined;
    });
    expect(toolReads.at(-1)).toEqual(["first", "second", "check"]);

    await host.updateCase(a.id, { status: "closed" });
    await host.updateCase(b.id, { status: "closed" });
    await eventually(() => closed[a.id] && closed[b.id]);
    expect(closed[a.id]).toEqual({
      inputs: ["first", "second", "check"],
      keys: ["inputs", "closed"],
    });
    expect(closed[b.id]).toEqual({ inputs: ["other"], keys: ["inputs", "closed"] });
  });
});
