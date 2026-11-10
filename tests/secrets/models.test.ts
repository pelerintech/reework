// Model providers take their API key from a declared secret or an environment
// variable, and exactly one of the two must be set.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, testDefinition } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";

const LLM_ENV = "REEWORK_TEST_LLM_KEY";
const SECRET_ENV = "REEWORK_TEST_LLM_SECRET";

afterEach(() => {
  delete process.env[LLM_ENV];
  delete process.env[SECRET_ENV];
});

describe("models through a secret", () => {
  it("sends a secret key to the model endpoint", async () => {
    process.env[SECRET_ENV] = "secret-key";
    const llm = await startFakeLlm();
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: { baseUrl: llm.url, apiKey: { secret: "llm" } },
          modelId: "m1",
        },
        secrets: { llm: { from: `env:${SECRET_ENV}` } },
      }),
      { models: undefined },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "hello", { wait: true });

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.headers.authorization).toBe("Bearer secret-key");
  });

  it("still sends an apiKeyEnv key", async () => {
    process.env[LLM_ENV] = "env-key";
    const llm = await startFakeLlm();
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: { baseUrl: llm.url, apiKeyEnv: LLM_ENV },
          modelId: "m1",
        },
      }),
      { models: undefined },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "hello", { wait: true });

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.headers.authorization).toBe("Bearer env-key");
  });

  it("sends a named model's secret key", async () => {
    process.env[LLM_ENV] = "main-env";
    process.env[SECRET_ENV] = "named-secret";
    const main = await startFakeLlm();
    const helper = await startFakeLlm();
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "use_helper",
            description: "Ask the helper model",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.models.complete("helper", { messages: "hello" });
              return "asked";
            },
          }),
        ],
      }),
      { models: ["helper"] },
    );
    main.script({ toolCall: { name: "use_helper" } }, { text: "done" });
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: { baseUrl: main.url, apiKeyEnv: LLM_ENV },
          modelId: "m1",
        },
        models: {
          helper: {
            provider: { baseUrl: helper.url, apiKey: { secret: "helper" } },
            modelId: "h1",
          },
        },
        secrets: { helper: { from: `env:${SECRET_ENV}` } },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: undefined },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(helper.requests).toHaveLength(1);
    expect(helper.requests[0]!.headers.authorization).toBe("Bearer named-secret");
  });

  it("fails naming the model when both key sources are set", async () => {
    process.env[LLM_ENV] = "env-key";
    process.env[SECRET_ENV] = "secret-key";
    const def: AgentDefinition = testDefinition({
      model: {
        provider: {
          baseUrl: "http://127.0.0.1:1",
          apiKeyEnv: LLM_ENV,
          apiKey: { secret: "llm" },
        },
        modelId: "m1",
      },
      secrets: { llm: { from: `env:${SECRET_ENV}` } },
    });
    await expect(startTestAgent(def, { models: undefined })).rejects.toThrow(
      /model "main".*exactly one of apiKeyEnv or apiKey/,
    );
  });

  it("fails naming the model when neither key source is set", async () => {
    const def: AgentDefinition = testDefinition({
      model: {
        provider: { baseUrl: "http://127.0.0.1:1" },
        modelId: "m1",
      },
    });
    await expect(startTestAgent(def, { models: undefined })).rejects.toThrow(
      /model "main".*exactly one of apiKeyEnv or apiKey/,
    );
  });

  it("fails naming a named model with both key sources", async () => {
    process.env[LLM_ENV] = "env-key";
    process.env[SECRET_ENV] = "secret-key";
    const def: AgentDefinition = testDefinition({
      model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: LLM_ENV }, modelId: "m1" },
      models: {
        helper: {
          provider: {
            baseUrl: "http://127.0.0.1:1",
            apiKeyEnv: LLM_ENV,
            apiKey: { secret: "helper" },
          },
          modelId: "h1",
        },
      },
      secrets: { helper: { from: `env:${SECRET_ENV}` } },
    });
    await expect(startTestAgent(def, { models: undefined })).rejects.toThrow(
      /model "helper".*exactly one of apiKeyEnv or apiKey/,
    );
  });
});
