import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin, defineTool, gatedAction, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor, waitForIdle } from "@reework/core/testing";
import { startAgent } from "@reework/core";
import { startFakeLlm } from "./support/fake-llm.ts";
import { tmpStorage } from "./support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const FAST = {
  provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" },
  modelId: "fast-model",
};

/** A tool-result message as a surface reads it from the conversation entries. */
interface ToolResultMessage {
  role?: string;
  details?: unknown;
  usage?: unknown;
}

function toolResultMessages(entries: readonly unknown[]): ToolResultMessage[] {
  return entries
    .flatMap((entry) => (entry as { model?: readonly unknown[] }).model ?? [])
    .filter((message): message is ToolResultMessage =>
      Boolean(message && (message as ToolResultMessage).role === "toolResult"),
    );
}

interface ModelCallUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

function modelUsageOf(message: ToolResultMessage): ModelCallUsage[] {
  const details = message.details as { reework?: { modelUsage?: ModelCallUsage[] } } | undefined;
  return details?.reework?.modelUsage ?? [];
}

function definition(extra?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "named",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "conv" },
    models: { fast: FAST },
    plugins: [],
    channels: [],
    mission: { role: "r" },
    ...extra,
  };
}

describe("named models", () => {
  it("a plugin calls a declared model and gets its text and usage", async () => {
    const seen: Record<string, unknown> = {};
    const classify = definePlugin(
      "classify",
      () => ({
        tools: [
          defineTool({
            name: "classify",
            description: "classify",
            parameters: Type.Object({ input: Type.String() }),
            async execute(_args, ctx) {
              const result = await ctx.models.complete("fast", { messages: "classify: dog" });
              seen.result = result;
              return `class:${result.text};in:${result.usage?.inputTokens ?? "?"}`;
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: classify, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("dog")]);
    test.model.respond([toolCall("classify", { input: "x" }), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go", { wait: true });
    // The tool got the named model's text and its usage.
    expect(seen.result).toMatchObject({ text: "dog" });
    expect((seen.result as { usage?: { inputTokens?: number } }).usage?.inputTokens).toBeDefined();
  });

  it("a plugin requiring an undeclared name fails startup with the spec message", async () => {
    const vision = definePlugin("v", () => ({}), { models: ["vision"] });
    await expect(
      startTestAgent(definition({ plugins: [{ plugin: vision, config: {} }] })),
    ).rejects.toThrow(/plugin "v" needs model "vision", which the agent does not declare/);
  });

  it("a plugin calling a name it did not request fails naming plugin and model", async () => {
    const sneaky = definePlugin(
      "s",
      () => ({
        tools: [
          defineTool({
            name: "peek",
            description: "peek",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.complete("fast", { messages: "x" });
                return "no-error";
              } catch (error) {
                return `err:${(error as Error).message}`;
              }
            },
          }),
        ],
      }),
      { models: [] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: sneaky, config: {} }] }));
    running.push(test);
    test.model.respond([toolCall("peek", {}), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go", { wait: true });
    const { entries } = await test.agent.host.readConversation(id);
    expect(JSON.stringify(entries)).toMatch(/did not request model/);
    expect(JSON.stringify(entries)).toContain("peek");
  });

  it("declares main, which is reserved, and startup fails", async () => {
    const def = definition({ models: { main: FAST } });
    await expect(startTestAgent(def)).rejects.toThrow(/main.*reserved/);
  });

  it("a passed-in catalog missing a declared named model fails startup", async () => {
    // A catalog covering only the conversation model (no `fast`).
    const { createMockModels } = await import("@reework/core/testing");
    const only = createMockModels();
    const llm = await startFakeLlm();
    const def = definition({
      model: { provider: { baseUrl: llm.url, apiKeyEnv: "K" }, modelId: "m1" },
    });
    process.env["K"] = "k";
    await expect(
      startAgent(def, {
        storagePath: tmpStorage(),
        auth: { token: "t" },
        models: only.models,
      }),
    ).rejects.toThrow(/model catalog is missing named model "fast"/);
  });

  it("a named model with a missing key variable fails startup naming it", async () => {
    const llm = await startFakeLlm();
    process.env["K"] = "k";
    const def = definition({
      model: { provider: { baseUrl: llm.url, apiKeyEnv: "K" }, modelId: "m1" },
      models: {
        fast: {
          provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "MISSING_KEY" },
          modelId: "f",
        },
      },
    });
    await expect(
      startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } }),
    ).rejects.toThrow(/MISSING_KEY/);
  });

  it("a named model that fails once throws and the endpoint sees one request", async () => {
    const llmConv = await startFakeLlm();
    const llmFast = await startFakeLlm();
    process.env["K"] = "k";
    const callFast = definePlugin(
      "cf",
      () => ({
        tools: [
          defineTool({
            name: "cf",
            description: "cf",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.complete("fast", { messages: "x" });
                return "ok";
              } catch (error) {
                return `err:${(error as Error).message}`;
              }
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );
    const def = definition({
      model: { provider: { baseUrl: llmConv.url, apiKeyEnv: "K" }, modelId: "m1" },
      models: {
        fast: { provider: { baseUrl: llmFast.url, apiKeyEnv: "K" }, modelId: "fast-model" },
      },
      plugins: [{ plugin: callFast, config: {} }],
    });
    const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
    running.push({ dispose: () => agent.stop() });
    const { id } = await agent.host.createConversation();
    llmConv.script({ toolCall: { name: "cf", args: {} } }, { text: "done" });
    llmFast.script({ status: 500 });
    await agent.host.submitInput(id, "go", { wait: true });
    // No retry: exactly one request to the failing named model.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(llmFast.requests.length).toBe(1);
  });

  it("records every named-model call's usage on a tool result", async () => {
    const spend = definePlugin(
      "spend",
      () => ({
        tools: [
          defineTool({
            name: "spend",
            description: "call fast twice",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.models.complete("fast", { messages: "first" });
              await ctx.models.complete("fast", { messages: "second" });
              return "spent";
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: spend, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("one"), text("two")]);
    test.model.respond([toolCall("spend", {}), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "spend", { wait: true });

    // The conversation, read as a surface reads it, records both calls.
    const { entries } = await test.agent.host.readConversation(id);
    const [result] = toolResultMessages(entries);
    const usage = modelUsageOf(result);
    expect(usage.map((u) => u.model)).toEqual(["fast", "fast"]);
    for (const call of usage) {
      expect(call.inputTokens).toBeGreaterThan(0);
      expect(call.outputTokens).toBeGreaterThan(0);
    }
  });

  it("carries the spend on the watch stream's tool-end event", async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
    const spend = definePlugin(
      "spend",
      () => ({
        tools: [
          defineTool({
            name: "spend",
            description: "call fast",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.models.complete("fast", { messages: "one" });
              await toolGate;
              return "spent";
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: spend, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("one")]);
    test.model.respond([toolCall("spend", {}), text("done")]);
    const { port, close } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await test.agent.host.createConversation();
    const ends: unknown[] = [];
    let snapshot = false;
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "snapshot") snapshot = true;
      if (frame.kind === "events") {
        ends.push(...frame.events.filter((e) => e.kind === "tool_execution_end"));
      }
    });
    running.push({
      dispose: async () => {
        watch.close();
        await close();
      },
    });
    await waitFor(() => snapshot);
    const submitted = test.agent.host.submitInput(id, "spend", { wait: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseTool();
    await submitted;

    const end = await waitFor(() => ends[0] as { result?: unknown });
    const entry = end.result as { model?: readonly unknown[] } | undefined;
    const [live] = toolResultMessages(entry ? [entry] : []);
    const usage = modelUsageOf(live);
    expect(usage.map((u) => u.model)).toEqual(["fast"]);
    expect(usage[0]?.inputTokens).toBeGreaterThan(0);
    expect(usage[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("keeps a tool's own details next to the named-model usage", async () => {
    const detailed = definePlugin(
      "detailed",
      () => ({
        tools: [
          defineTool({
            name: "detailed",
            description: "return details",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.models.complete("fast", { messages: "one" });
              return { output: "ok", details: { note: "keep me" } };
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: detailed, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("one")]);
    test.model.respond([toolCall("detailed", {}), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "detail", { wait: true });

    const { entries } = await test.agent.host.readConversation(id);
    const [result] = toolResultMessages(entries);
    expect((result.details as { note?: string }).note).toBe("keep me");
    expect(modelUsageOf(result).map((u) => u.model)).toEqual(["fast"]);
  });

  it("records a gated action run's named-model usage in its outcome", async () => {
    const gated = definePlugin(
      "gated",
      () => ({
        tools: [
          gatedAction({
            name: "act",
            gate: { title: "Act?", options: [{ id: "go", label: "Go" }] },
            async run(ctx) {
              await ctx.models.complete("fast", { messages: "one" });
              await ctx.models.complete("fast", { messages: "two" });
              return "acted";
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: gated, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("one"), text("two")]);
    test.model.respond([toolCall("act", {}), text("asked")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "act", { wait: true });

    const proposal = await waitFor(() =>
      test.agent.host.listProposals({ conversationId: id }).then((p) => p[0]),
    );
    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await waitForIdle(test.agent.host, id);

    const { entries } = await test.agent.host.readConversation(id);
    const outcome = entries
      .flatMap(
        (entry) =>
          (entry as { model?: readonly { role?: string; content?: unknown }[] }).model ?? [],
      )
      .find(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[gated action act]"),
      );
    const outcomeText = String((outcome as { content?: string } | undefined)?.content ?? "");
    expect(outcomeText).toContain("acted");
    expect(outcomeText).toContain('"model":"fast"');
    expect(outcomeText).toMatch(/"inputTokens":[1-9]/);
    expect(outcomeText).toMatch(/"outputTokens":[1-9]/);
  });
});
