import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@reework/core";
import { definePlugin, defineTool } from "@reework/core";
import type { TSchema } from "@reework/core";
import { startTestAgent, text, toolCall, toolCalls, waitFor } from "@reework/core/testing";

const agent = {
  name: "store",
  model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [],
  channels: [],
  mission: { role: "You use the store." },
};

const running: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const params = (props: Record<string, TSchema> = {}) =>
  Type.Object({ ...props }, { additionalProperties: false });

function storeTools() {
  return [
    defineTool({
      name: "setAgent",
      description: "Set an agent-scope value.",
      parameters: params({ key: Type.String(), value: Type.Union([Type.Number(), Type.String()]) }),
      async execute(args: { key: string; value: unknown }, ctx) {
        await ctx.store.agent.set(args.key, args.value as never);
        return "set";
      },
    }),
    defineTool({
      name: "getAgent",
      description: "Read an agent-scope value.",
      parameters: params({ key: Type.String() }),
      async execute(args: { key: string }, ctx) {
        const value = (await ctx.store.agent.get(args.key)) as string | undefined;
        return value === undefined ? "(none)" : value;
      },
    }),
    defineTool({
      name: "setCase",
      description: "Set a case-scope value.",
      parameters: params({ key: Type.String(), value: Type.Union([Type.Number(), Type.String()]) }),
      async execute(args: { key: string; value: unknown }, ctx) {
        await ctx.store.case.set(args.key, args.value as never);
        return "set";
      },
    }),
    defineTool({
      name: "getCase",
      description: "Read a case-scope value.",
      parameters: params({ key: Type.String() }),
      async execute(args: { key: string }, ctx) {
        const value = (await ctx.store.case.get(args.key)) as string | undefined;
        return value === undefined ? "(none)" : value;
      },
    }),
    defineTool({
      name: "incrA",
      description: "Increment the shared counter.",
      parameters: params(),
      async execute(_args, ctx) {
        await ctx.store.agent.update("counter", (v) => (typeof v === "number" ? v + 1 : 1));
        return "done";
      },
    }),
    defineTool({
      name: "incrB",
      description: "Increment the shared counter too.",
      parameters: params(),
      async execute(_args, ctx) {
        await ctx.store.agent.update("counter", (v) => (typeof v === "number" ? v + 1 : 1));
        return "done";
      },
    }),
    defineTool({
      name: "listAgent",
      description: "List agent-scope keys with a prefix.",
      parameters: params({ prefix: Type.String() }),
      async execute(args: { prefix: string }, ctx) {
        const items = await ctx.store.agent.list(args.prefix);
        return JSON.stringify(items.map((i) => i.key));
      },
    }),
  ];
}

async function readOf(
  test: Awaited<ReturnType<typeof startTestAgent>>,
  id: string,
): Promise<string> {
  return JSON.stringify((await test.agent.host.readConversation(id)).entries);
}

describe("plugin storage through the facade", () => {
  it("namespaces by plugin, scopes agent vs case, and lists by prefix", async () => {
    const plugin = definePlugin("store", () => ({ tools: storeTools() }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation({ key: "a" });
    const other = await test.agent.host.createConversation({ key: "b" });

    test.model.respond([
      toolCall("setAgent", { key: "k", value: "p1" }),
      toolCall("setCase", { key: "c", value: "case-a" }),
      toolCall("setAgent", { key: "item/x", value: 1 }),
      toolCall("setAgent", { key: "item/y", value: 2 }),
      toolCall("setAgent", { key: "other/z", value: 3 }),
      text("done"),
    ]);
    await test.agent.host.submitInput(id, "go", { wait: true });
    expect(await readOf(test, id)).toContain("p1");

    test.model.append([
      toolCall("getAgent", { key: "k" }),
      toolCall("getCase", { key: "c" }),
      toolCall("listAgent", { prefix: "item/" }),
      text("done"),
    ]);
    await test.agent.host.submitInput(other.id, "look", { wait: true });
    const otherRead = await readOf(test, other.id);
    expect(otherRead).toContain("p1");
    expect(otherRead).toContain("(none)");
    expect(otherRead).toContain("item/x");
    expect(otherRead).toContain("item/y");
    expect(otherRead).not.toContain("other/z");
  });

  it("commits an atomic update under two concurrent calls", async () => {
    const plugin = definePlugin("store", () => ({ tools: storeTools() }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    test.model.respond([
      toolCalls([["incrA"], ["incrB"]]),
      toolCall("getAgent", { key: "counter" }),
      text("done"),
    ]);
    await test.agent.host.submitInput(id, "go", { wait: true });
    await waitFor(async () => (await readOf(test, id)).includes("2"));
  });

  it("keeps values across a restart and lets setup read the same store", async () => {
    let setupRan = false;
    const plugin = definePlugin("store", () => ({
      tools: storeTools(),
      async setup(ctx) {
        await ctx.store.agent.set("boot", "from-setup");
        setupRan = true;
      },
    }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation({ key: "k" });
    test.model.respond([toolCall("getAgent", { key: "boot" }), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });
    expect(setupRan).toBe(true);
    await waitFor(async () => (await readOf(test, id)).includes("from-setup"));
  });
});

describe("plugin store is namespaced per plugin", () => {
  it("two plugins reading the same key get their own values", async () => {
    const make = (name: string, suffix: string) =>
      definePlugin(name, () => ({
        tools: [
          defineTool({
            name: `${suffix}Peek`,
            description: "Read the same key.",
            parameters: params(),
            async execute(_args, ctx) {
              const value = (await ctx.store.agent.get("same")) as string | undefined;
              return value ?? `none-${name}`;
            },
          }),
          defineTool({
            name: `${suffix}Poke`,
            description: "Write the same key.",
            parameters: params({ value: Type.String() }),
            async execute(args: { value: string }, ctx) {
              await ctx.store.agent.set("same", args.value);
              return "set";
            },
          }),
        ],
      }));
    const a = make("a", "a");
    const b = make("b", "b");
    const test = await startTestAgent({
      ...agent,
      plugins: [
        { plugin: a, config: {} },
        { plugin: b, config: {} },
      ],
    });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    test.model.respond([
      toolCall("aPoke", { value: "A" }),
      toolCall("bPoke", { value: "B" }),
      toolCall("aPeek"),
      toolCall("bPeek"),
      text("done"),
    ]);
    await test.agent.host.submitInput(id, "go", { wait: true });
    const read = await readOf(test, id);
    expect(read).toContain("A");
    expect(read).toContain("B");
  });
});
