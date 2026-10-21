import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, section } from "@reework/core";
import { startTestAgent, testDefinition } from "./support/agent.ts";
import { startFakeLlm, systemText } from "./support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";

beforeEach(() => {
  process.env[KEY_ENV] = "sk-test-123";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

async function ask(agent: Awaited<ReturnType<typeof startTestAgent>>, text: string) {
  const conversation = await agent.host.createConversation();
  return agent.host.submitInput(conversation.id, text, { wait: true });
}

describe("the agent's model is the configured custom endpoint", () => {
  it("sends requests for modelId with the key from apiKeyEnv and returns the reply", async () => {
    const llm = await startFakeLlm();
    llm.script({ text: "pong" });
    const agent = await startTestAgent(
      testDefinition({
        model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      }),
      { models: undefined },
    );

    const reply = await ask(agent, "ping");

    expect(reply.message?.content).toEqual([{ type: "text", text: "pong" }]);
    expect(llm.requests).toHaveLength(1);
    const [request] = llm.requests;
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.body.model).toBe("m1");
    expect(request.headers.authorization).toBe("Bearer sk-test-123");
  });

  it("stops startup naming the key variable when it is not set", async () => {
    await expect(
      startTestAgent(
        testDefinition({
          model: {
            provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "REEWORK_MISSING_KEY" },
            modelId: "m1",
          },
        }),
        { models: undefined },
      ),
    ).rejects.toThrow(/REEWORK_MISSING_KEY/);
  });

  it("speaks the Anthropic messages protocol when api is anthropic-messages", async () => {
    const llm = await startFakeLlm();
    llm.script({ text: "bonjour" });
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: { baseUrl: llm.root, apiKeyEnv: KEY_ENV, api: "anthropic-messages" },
          modelId: "claude-like",
        },
      }),
      { models: undefined },
    );

    const reply = await ask(agent, "salut");

    expect(reply.message?.content).toEqual([{ type: "text", text: "bonjour" }]);
    expect(llm.requests[0].path).toMatch(/^\/v1\/messages(\?|$)/);
    expect(llm.requests[0].body.model).toBe("claude-like");
  });

  it("sends the mission role and plugin sections as the model's instructions", async () => {
    const llm = await startFakeLlm();
    const alpha = definePlugin("alpha", () => ({
      sections: [section("alpha", () => "ALPHA-SECTION", { tag: false })],
    }));
    const agent = await startTestAgent(
      testDefinition({
        model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
        mission: { role: "ROLE-MARKER: you are on call." },
        plugins: [{ plugin: alpha, config: {} }],
      }),
      { models: undefined },
    );

    await ask(agent, "hello");

    const instructions = systemText(llm.requests[0]);
    expect(instructions).toContain("ROLE-MARKER: you are on call.");
    expect(instructions).toContain("ALPHA-SECTION");
  });

  it("retries a transient endpoint failure and still answers", async () => {
    const llm = await startFakeLlm();
    llm.script(
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { text: "recovered" },
    );
    const agent = await startTestAgent(
      testDefinition({
        model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      }),
      { models: undefined, settings: { retry: { baseDelayMs: 10, maxAgentDelayMs: 50 } } },
    );

    const reply = await ask(agent, "hello");

    expect(reply.message?.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
  });
});
