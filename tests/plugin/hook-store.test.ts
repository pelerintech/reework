import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";

const running: TestAgent[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((agent) => agent.dispose()));
});

function definition(extra?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "hook-store",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "conv" },
    plugins: [],
    channels: [],
    mission: { role: "r" },
    ...extra,
  };
}

const fetchPage = defineTool({
  name: "fetch_page",
  description: "fetch a page",
  parameters: Type.Object({}),
  async execute() {
    return "page text";
  },
});
const deleteItem = defineTool({
  name: "delete_item",
  description: "delete an item",
  parameters: Type.Object({}),
  async execute() {
    return "deleted";
  },
});

describe("plugin store in run hooks", () => {
  it("lets hooks keep case state that later hooks and the plugin's tools read", async () => {
    const seen: { request?: unknown; tool?: unknown } = {};
    const guard = definePlugin("guard", () => ({
      tools: [
        fetchPage,
        deleteItem,
        defineTool({
          name: "read_mark",
          description: "read the mark",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            seen.tool = (await ctx.store.case.get("mark")) ?? null;
            return "ok";
          },
        }),
      ],
      hooks: {
        async beforeModelRequest({ messages }, ctx) {
          if (!("request" in seen)) seen.request = (await ctx.store.case.get("mark")) ?? null;
          await ctx.store.case.set("requests", messages.length);
          return undefined;
        },
        async afterTool(call, result, ctx) {
          if (call.name === "fetch_page") {
            await ctx.store.case.set("mark", { tainted: true, source: "output of fetch_page" });
          }
          return result;
        },
        async beforeTool(call, ctx) {
          const mark = (await ctx.store.case.get("mark")) as
            | { tainted: boolean; source: string }
            | undefined;
          if (call.name === "delete_item" && mark?.tainted) {
            return { block: `not after untrusted content (${mark.source})` };
          }
          return undefined;
        },
      },
    }));
    const results: [string, boolean, string][] = [];
    const observer = definePlugin("observer", () => ({
      hooks: {
        async afterTool(call, result) {
          results.push([call.name, result.isError === true, String(result.output)]);
          return undefined;
        },
      },
    }));
    const test = await startTestAgent(
      definition({
        plugins: [
          { plugin: guard, config: {} },
          { plugin: observer, config: {} },
        ],
      }),
    );
    running.push(test);
    test.model.respond([
      toolCall("fetch_page", {}),
      toolCall("delete_item", {}),
      toolCall("read_mark", {}),
      text("done"),
    ]);

    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(results).toEqual([
      ["fetch_page", false, "page text"],
      ["delete_item", true, "not after untrusted content (output of fetch_page)"],
      ["read_mark", false, "ok"],
    ]);
    expect(seen.request).toBeNull();
    expect(seen.tool).toEqual({ tainted: true, source: "output of fetch_page" });
  });

  it("keeps each plugin's hook state in its own namespace", async () => {
    const reads: Record<string, unknown> = {};
    const writer = (name: string, value: string) =>
      definePlugin(name, () => ({
        hooks: {
          async beforeModelRequest(_request, ctx) {
            reads[name] = (await ctx.store.case.get("who")) ?? null;
            await ctx.store.case.set("who", value);
            return undefined;
          },
        },
      }));
    const test = await startTestAgent(
      definition({
        plugins: [
          { plugin: writer("first", "a"), config: {} },
          { plugin: writer("second", "b"), config: {} },
        ],
      }),
    );
    running.push(test);
    test.model.respond([text("one"), text("two")]);

    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "hi", { wait: true });
    await test.agent.host.submitInput(id, "again", { wait: true });

    expect(reads).toEqual({ first: "a", second: "b" });
  });
});
