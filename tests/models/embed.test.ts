// `ctx.models.embed` calls a named model's OpenAI-compatible embeddings
// endpoint directly, reports its usage like completions, refuses protocols
// without embeddings, and honours `beforeModelCall`.
import { afterEach, describe, expect, it } from "vitest";
import { ModelCallRefused, Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, ModelEmbedResult, ModelUsageEvent } from "@reework/core";
import { startFakeEmbeddings } from "../support/fake-embeddings.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import { startTestAgent, testDefinition } from "../support/agent.ts";
import { eventually } from "../support/wait.ts";

const LLM_ENV = "REEWORK_TEST_EMBED_LLM_KEY";
const EMBED_ENV = "REEWORK_TEST_EMBED_KEY";

afterEach(() => {
  delete process.env[LLM_ENV];
  delete process.env[EMBED_ENV];
});

function definition(
  llmUrl: string,
  embedUrl: string,
  plugins: AgentDefinition["plugins"],
): AgentDefinition {
  return testDefinition({
    name: "embed-agent",
    model: { provider: { baseUrl: llmUrl, apiKeyEnv: LLM_ENV }, modelId: "m1" },
    models: {
      embedder: {
        provider: { baseUrl: embedUrl, apiKeyEnv: EMBED_ENV },
        modelId: "text-embedding-3-small",
      },
      "chat-only": {
        provider: { baseUrl: embedUrl, apiKeyEnv: EMBED_ENV, api: "anthropic-messages" },
        modelId: "chat-only-model",
      },
    },
    plugins,
    mission: { role: "You are an embedding test agent." },
  });
}

function observerPlugin(seen: ModelUsageEvent[]) {
  return definePlugin("observer", () => ({
    hooks: {
      async onModelUsage(event) {
        seen.push(event);
      },
    },
  }));
}

describe("ctx.models.embed", () => {
  it("returns the named model's vectors and sends its model and input", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({
      embeddings: [
        [0.25, 0.5],
        [0.75, 1],
      ],
    });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed two passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", ["a", "b"]);
              return "embedded";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(seen?.embeddings).toEqual([
      [0.25, 0.5],
      [0.75, 1],
    ]);
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]).toMatchObject({
      path: "/v1/embeddings",
      model: "text-embedding-3-small",
      input: ["a", "b"],
    });
    expect(endpoint.requests[0]!.headers.authorization).toBe("Bearer embed-key");
  });

  it("orders vectors by each item's index", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({
      items: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
      ],
    });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed two passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", ["a", "b"]);
              return "embedded";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(seen?.embeddings).toEqual([[1], [2]]);
  });

  it("reports embedding usage like a completion", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({
      embeddings: [[0.1, 0.2]],
      usage: { promptTokens: 12, totalTokens: 12 },
    });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    const seenUsage: ModelUsageEvent[] = [];
    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed a passage",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", ["a"]);
              return "embedded";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [
        { plugin: observerPlugin(seenUsage), config: {} },
        { plugin: embedder, config: {} },
      ]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });
    await eventually(() => seenUsage.some((event) => event.source === "plugin"));

    const usage = seenUsage.find((event) => event.source === "plugin");
    expect(usage).toMatchObject({
      source: "plugin",
      plugin: "embedder",
      model: "embedder",
      conversationId: id,
      usage: {
        inputTokens: 12,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 12,
      },
    });
    expect(seen?.usage).toEqual(usage!.usage);
  });

  it("refuses a model whose protocol has no embeddings, sending nothing", async () => {
    const endpoint = await startFakeEmbeddings();
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seenError: unknown;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed with a chat-only model",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.embed("chat-only", ["a"]);
              } catch (error) {
                seenError = error;
              }
              return "done";
            },
          }),
        ],
      }),
      { models: ["chat-only"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("ModelHasNoEmbeddings");
    expect((seenError as Error).message).toContain("chat-only");
    expect(endpoint.requests).toHaveLength(0);
  });

  it("honours a beforeModelCall refusal before sending anything", async () => {
    const endpoint = await startFakeEmbeddings();
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    const blocker = definePlugin("blocker", () => ({
      hooks: {
        async beforeModelCall({ model }) {
          if (model === "embedder") return { refuse: "budget" };
        },
      },
    }));
    let seenError: unknown;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed a passage",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.embed("embedder", ["a"]);
              } catch (error) {
                seenError = error;
              }
              return "done";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [
        { plugin: blocker, config: {} },
        { plugin: embedder, config: {} },
      ]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(seenError).toBeInstanceOf(ModelCallRefused);
    expect((seenError as ModelCallRefused).reason).toBe("budget");
    expect(endpoint.requests).toHaveLength(0);
  });

  it("returns vectors and reports no usage when the response has none", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ embeddings: [[1, 2]] });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    const seenUsage: ModelUsageEvent[] = [];
    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed a passage",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", ["a"]);
              return "embedded";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [
        { plugin: observerPlugin(seenUsage), config: {} },
        { plugin: embedder, config: {} },
      ]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });
    // The run's own usage event arrives after the embed call's would have.
    await eventually(() => seenUsage.some((event) => event.source === "run"));

    expect(seen?.embeddings).toEqual([[1, 2]]);
    expect(seen?.usage).toBeUndefined();
    expect(seenUsage.filter((event) => event.source === "plugin")).toHaveLength(0);
  });
});
