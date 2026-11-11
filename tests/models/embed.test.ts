// `ctx.models.embed` calls a named model's OpenAI-compatible embeddings
// endpoint directly, reports its usage like completions, refuses protocols
// without embeddings, and honours `beforeModelCall`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCallRefused, Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, ModelEmbedResult, ModelUsageEvent } from "@reework/core";
import { startFakeEmbeddings } from "../support/fake-embeddings.ts";
import { startFakeGateway } from "../support/fake-gateway.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import { startTestAgent, testDefinition } from "../support/agent.ts";
import { eventually } from "../support/wait.ts";

const LLM_ENV = "REEWORK_TEST_EMBED_LLM_KEY";
const EMBED_ENV = "REEWORK_TEST_EMBED_KEY";

afterEach(() => {
  delete process.env[LLM_ENV];
  delete process.env[EMBED_ENV];
  vi.restoreAllMocks();
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
        maxConcurrentRequests: 1,
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

  it("passes the caller's signal to the request", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ embeddings: [[1]], delayMs: 500 });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seenError: unknown;
    let elapsed = 0;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed a passage",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 50);
              const started = Date.now();
              try {
                await ctx.models.embed("embedder", ["a"], { signal: controller.signal });
              } catch (error) {
                seenError = error;
              } finally {
                elapsed = Date.now() - started;
                clearTimeout(timer);
              }
              return "done";
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

    expect((seenError as Error).name).toBe("AbortError");
    expect(elapsed).toBeLessThan(400);
  });

  it("aborts an embed call with the tool context's signal", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ embeddings: [[1]], delayMs: 500 });
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go");
    await eventually(() => endpoint.requests.length === 1);
    await agent.host.abort(id);
    await eventually(() => seenError !== undefined);

    expect((seenError as Error).name).toBe("AbortError");
  });

  it("records embed usage on the tool result's ledger", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ embeddings: [[1]], usage: { promptTokens: 7, totalTokens: 7 } });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed a passage",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.models.embed("embedder", ["a"]);
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

    const { entries } = await agent.host.readConversation(id);
    const messages = entries.flatMap(
      (entry) => (entry as { model?: readonly unknown[] }).model ?? [],
    );
    const toolResult = messages.find(
      (message) => (message as { role?: string }).role === "toolResult",
    ) as {
      details?: { reework?: { modelUsage?: { model: string; inputTokens: number }[] } };
    };
    expect(toolResult.details?.reework?.modelUsage).toEqual([
      { model: "embedder", inputTokens: 7, outputTokens: 0 },
    ]);
  });

  it("batches inputs in groups of at most 512 and sums their usage", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond(
      {
        embeddings: Array.from({ length: 512 }, (_, i) => [i]),
        usage: { promptTokens: 512, totalTokens: 512 },
      },
      { embeddings: [[512]], usage: { promptTokens: 1, totalTokens: 1 } },
    );
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    const texts = Array.from({ length: 513 }, (_, i) => `text-${i}`);
    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed many passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", texts);
              return "done";
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

    expect(endpoint.requests.map((request) => request.input.length)).toEqual([512, 1]);
    expect(seen?.embeddings).toHaveLength(513);
    expect(seen?.embeddings[0]).toEqual([0]);
    expect(seen?.embeddings[512]).toEqual([512]);
    expect(seen?.usage).toMatchObject({ inputTokens: 513, totalTokens: 513 });
  });

  it("returns no vectors for empty input without a request", async () => {
    const endpoint = await startFakeEmbeddings();
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
            description: "embed nothing",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", []);
              return "done";
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

    expect(seen?.embeddings).toEqual([]);
    expect(endpoint.requests).toHaveLength(0);
  });

  it("names a non-JSON response instead of a raw SyntaxError", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ raw: "not json" });
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingResponseInvalid");
    expect((seenError as Error).message).toContain('plugin "embedder"');
    expect((seenError as Error).message).toContain('model "embedder"');
    expect((seenError as Error).message).toContain("JSON");
  });

  it("shares the model's maxConcurrentRequests limiter", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ embeddings: [[1]], delayMs: 100 }, { embeddings: [[2]], delayMs: 100 });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seen: ModelEmbedResult[] = [];
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed two passages concurrently",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await Promise.all([
                ctx.models.embed("embedder", ["a"]),
                ctx.models.embed("embedder", ["b"]),
              ]);
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

    expect(seen.map((result) => result.embeddings)).toEqual([[[1]], [[2]]]);
    expect(endpoint.load.peak).toBe(1);
  });

  it("times out an embed call with the gateway backend's timeout", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ embeddings: [[1]], delayMs: 300 });
    const llm = await startFakeLlm();
    const gateway = await startFakeGateway({
      secrets: {},
      raw: [],
      upstreams: {
        main: { baseUrl: llm.url, apiKey: "main-key" },
        embedder: { baseUrl: endpoint.url, apiKey: "embed-key" },
      },
    });
    const boxToken = "REEWORK_TEST_EMBED_BOX_TOKEN";
    process.env[boxToken] = "box-token";
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seenError: unknown;
    let elapsed = 0;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed a passage",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const started = Date.now();
              try {
                await ctx.models.embed("embedder", ["a"]);
              } catch (error) {
                seenError = error;
              } finally {
                elapsed = Date.now() - started;
              }
              return "done";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      {
        ...definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: boxToken, timeoutMs: 50 },
      },
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingTimeoutError");
    expect((seenError as Error).message).toContain('plugin "embedder"');
    expect((seenError as Error).message).toContain('model "embedder"');
    expect(elapsed).toBeLessThan(250);
    delete process.env[boxToken];
  });

  it("rejects a response with a vector missing for an input", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ items: [{ index: 0, embedding: [1] }] });
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
            description: "embed two passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.embed("embedder", ["a", "b"]);
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingResponseInvalid");
    expect((seenError as Error).message).toContain('plugin "embedder"');
    expect((seenError as Error).message).toContain('model "embedder"');
    expect((seenError as Error).message).toContain("2");
  });

  it("rejects vectors with inconsistent dimensions", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({
      items: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [3] },
      ],
    });
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
            description: "embed two passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.embed("embedder", ["a", "b"]);
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingResponseInvalid");
    expect((seenError as Error).message).toContain('plugin "embedder"');
    expect((seenError as Error).message).toContain('model "embedder"');
    expect((seenError as Error).message).toContain("dimension");
  });

  it("warns once when only some batches report usage", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond(
      {
        embeddings: Array.from({ length: 512 }, () => [1]),
        usage: { promptTokens: 512, totalTokens: 512 },
      },
      { embeddings: [[1]] },
    );
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const texts = Array.from({ length: 513 }, (_, i) => `text-${i}`);
    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed many passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", texts);
              return "done";
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

    expect(seen?.usage).toMatchObject({ inputTokens: 512, totalTokens: 512 });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('plugin "embedder"');
    expect(message).toContain('model "embedder"');
  });

  it("rejects dimensions that differ across batches", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond(
      { embeddings: Array.from({ length: 512 }, () => [1, 2]) },
      { embeddings: [[1, 2, 3]] },
    );
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    const texts = Array.from({ length: 513 }, (_, i) => `text-${i}`);
    let seenError: unknown;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed many passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              try {
                await ctx.models.embed("embedder", texts);
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingResponseInvalid");
    expect((seenError as Error).message).toContain('plugin "embedder"');
    expect((seenError as Error).message).toContain('model "embedder"');
    expect((seenError as Error).message).toContain("dimension");
  });

  it("rejects a zero-length vector", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ items: [{ index: 0, embedding: [] }] });
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingResponseInvalid");
    expect((seenError as Error).message).toContain("positive");
  });

  it("rejects a vector element that is not a finite number", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({ items: [{ index: 0, embedding: [1, null] }] });
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
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect((seenError as Error).name).toBe("EmbeddingResponseInvalid");
    expect((seenError as Error).message).toContain("finite number");
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
