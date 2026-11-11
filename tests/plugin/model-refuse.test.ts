// A plugin's `beforeModelCall` may refuse a named-model call: the caller receives
// `ModelCallRefused` with the reason and no request reaches the model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCallRefused, Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

describe("refusing named-model calls", () => {
  it("throws ModelCallRefused from a tool and from setup, sending no request", async () => {
    const mainLlm = await startFakeLlm();
    const helperLlm = await startFakeLlm();
    const observer = definePlugin("observer", () => ({
      hooks: {
        async beforeModelCall({ model }) {
          if (model === "helper") return { refuse: "budget" };
        },
      },
    }));
    let setupError: unknown;
    let toolError: unknown;
    const helper = definePlugin(
      "helper",
      () => ({
        tools: [
          defineTool({
            name: "use-helper",
            description: "Ask the helper model",
            parameters: Type.Object({}),
            execute: async (_args, ctx) => {
              toolError = await ctx.models.complete("helper", { messages: "tool" }).then(
                () => undefined,
                (error: unknown) => error,
              );
              return "not called";
            },
          }),
        ],
        async setup(ctx) {
          setupError = await ctx.models.complete("helper", { messages: "setup" }).then(
            () => undefined,
            (error: unknown) => error,
          );
        },
      }),
      { models: ["helper"] },
    );
    const definition: AgentDefinition = {
      name: "refusing-agent",
      model: { provider: { baseUrl: mainLlm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      models: {
        helper: { provider: { baseUrl: helperLlm.url, apiKeyEnv: KEY_ENV }, modelId: "h1" },
      },
      plugins: [
        { plugin: observer, config: {} },
        { plugin: helper, config: {} },
      ],
      channels: [],
      mission: { role: "You work with a helper." },
    };
    mainLlm.script({ toolCall: { name: "use-helper" } }, { text: "done" });
    const agent = await startTestAgent(definition, { models: undefined });
    const { id } = await agent.host.createConversation();

    await agent.host.submitInput(id, "go", { wait: true });

    expect(setupError).toBeInstanceOf(ModelCallRefused);
    expect((setupError as ModelCallRefused).reason).toBe("budget");
    expect(toolError).toBeInstanceOf(ModelCallRefused);
    expect((toolError as ModelCallRefused).reason).toBe("budget");
    expect(helperLlm.requests).toHaveLength(0);
    expect(mainLlm.requests).toHaveLength(2);
  });

  it("logs a throwing beforeModelCall and lets the call proceed", async () => {
    const mainLlm = await startFakeLlm();
    const helperLlm = await startFakeLlm();
    const thrower = definePlugin("thrower", () => ({
      hooks: {
        async beforeModelCall() {
          throw new Error("not my call");
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
      }),
      { models: ["helper"] },
    );
    const definition: AgentDefinition = {
      name: "throwing-agent",
      model: { provider: { baseUrl: mainLlm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      models: {
        helper: { provider: { baseUrl: helperLlm.url, apiKeyEnv: KEY_ENV }, modelId: "h1" },
      },
      plugins: [
        { plugin: thrower, config: {} },
        { plugin: helper, config: {} },
      ],
      channels: [],
      mission: { role: "You work with a helper." },
    };
    mainLlm.script({ toolCall: { name: "use-helper" } }, { text: "done" });
    helperLlm.script({ text: "helper answer" });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const agent = await startTestAgent(definition, { models: undefined });
    const { id } = await agent.host.createConversation();

    await agent.host.submitInput(id, "go", { wait: true });
    spy.mockRestore();

    expect(helperLlm.requests).toHaveLength(1);
    const logged = errors.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain('plugin "thrower"');
    expect(logged).toContain("beforeModelCall");
  });
});
