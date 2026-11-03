// Async plugin factories: a factory may await discovery before returning its tools;
// factories run in declaration order and a rejection stops startup cleanly.
import { describe, expect, it, expectTypeOf } from "vitest";
import { definePlugin, defineTool, startAgent, Type } from "@reework/core";
import type { AgentDefinition, BuiltPlugin, ReeworkPlugin } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import { fauxModels, tmpStorage } from "../support/agent.ts";

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "async-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You look things up." },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("async plugin factories", () => {
  it("installs the tools of an async factory", async () => {
    let ran = false;
    const lookup = defineTool({
      name: "lookup",
      description: "Look up an item.",
      parameters: Type.Object({ id: Type.String() }),
      async execute(args) {
        ran = true;
        return `found:${args.id}`;
      },
    });
    const plugin = definePlugin("lookup", async () => {
      await delay(20);
      return { tools: [lookup] };
    });

    const agent = await startTestAgent(definition([{ plugin, config: {} }]));
    agent.model.respond([toolCall("lookup", { id: "1" }), text("done")]);
    const { id } = await agent.agent.host.createConversation();
    const result = await agent.agent.host.submitInput(id, "look it up", { wait: true });
    await agent.dispose();

    expect(ran).toBe(true);
    const content = result.message?.content;
    const answer =
      typeof content === "string"
        ? content
        : (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(answer).toBe("done");
  });

  it("runs factories in declaration order", async () => {
    const log: string[] = [];
    const recorder = (name: string) =>
      definePlugin(name, async () => {
        log.push(`start:${name}`);
        await delay(20);
        log.push(`end:${name}`);
        return {};
      });
    const agent = await startTestAgent(
      definition([
        { plugin: recorder("p1"), config: {} },
        { plugin: recorder("p2"), config: {} },
      ]),
    );
    await agent.dispose();

    expect(log).toEqual(["start:p1", "end:p1", "start:p2", "end:p2"]);
  });

  it("stops startup when an async factory rejects", async () => {
    let stops = 0;
    const a = definePlugin("a", () => ({
      stop() {
        stops += 1;
      },
    }));
    const b = definePlugin("b", async () => {
      await delay(10);
      throw new Error("cannot reach server");
    });
    const storagePath = tmpStorage();
    const plugins = [
      { plugin: a, config: {} },
      { plugin: b, config: {} },
    ];

    await expect(
      startAgent(definition(plugins), {
        storagePath,
        models: fauxModels("m1").models,
        auth: { token: "async-token" },
      }),
    ).rejects.toThrow(/plugin "b" failed: cannot reach server/);
    expect(stops).toBe(1);

    const next = await startTestAgent(definition([]), { storagePath });
    await next.dispose();
  });

  it("accepts a factory returning a promise in the type", () => {
    const plugin = definePlugin("typed", async () => ({}) as BuiltPlugin);
    expectTypeOf(plugin).toMatchTypeOf<ReeworkPlugin>();
    expectTypeOf(plugin.build({})).toEqualTypeOf<Promise<BuiltPlugin>>();
  });
});
