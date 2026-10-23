// A custom endpoint's real limits: the output cap reaches every request, and the
// context window decides when the conversation is compacted.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentModel } from "@reework/core";
import { startTestAgent, testDefinition } from "./support/agent.ts";
import { startFakeLlm } from "./support/fake-llm.ts";
import type { FakeLlm } from "./support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "sk-test";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

function modelOf(llm: FakeLlm | undefined, limits: Partial<AgentModel> = {}): AgentModel {
  return {
    provider: { baseUrl: llm?.url ?? "http://127.0.0.1:1/v1", apiKeyEnv: KEY_ENV },
    modelId: "m1",
    ...limits,
  };
}

const outputCap = (body: Record<string, unknown>) => body.max_completion_tokens ?? body.max_tokens;

/**
 * Two long answers (~25k tokens each), then a third input: whether that input is
 * preceded by a compaction depends only on the declared window.
 */
async function compactsOnThirdTurn(limits: Partial<AgentModel>): Promise<boolean> {
  const llm = await startFakeLlm();
  llm.script(
    { text: "a ".repeat(50_000), usage: { input: 100 } },
    { text: "b ".repeat(50_000), usage: { input: 26_000 } },
  );
  const agent = await startTestAgent(testDefinition({ model: modelOf(llm, limits) }), {
    models: undefined,
  });
  const { id } = await agent.host.createConversation();
  for (const input of ["one", "two", "three"]) {
    await agent.host.submitInput(id, input, { wait: true });
  }
  const { entries } = await agent.host.readConversation(id);
  return entries.some((entry) => entry.kind.includes("compaction"));
}

describe("declared model limits", () => {
  it("caps every request's output at maxTokens", async () => {
    const llm = await startFakeLlm();
    const agent = await startTestAgent(
      testDefinition({ model: modelOf(llm, { contextWindow: 300_000, maxTokens: 30_000 }) }),
      { models: undefined },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "hi", { wait: true });
    expect(outputCap(llm.requests[0].body)).toBe(30_000);
  });

  it("keeps the 8192-token output default when nothing is declared", async () => {
    const llm = await startFakeLlm();
    const agent = await startTestAgent(testDefinition({ model: modelOf(llm) }), {
      models: undefined,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "hi", { wait: true });
    expect(outputCap(llm.requests[0].body)).toBe(8_192);
  });

  it("compacts by the declared context window", async () => {
    expect(await compactsOnThirdTurn({ contextWindow: 40_000, maxTokens: 1_000 })).toBe(true);
    expect(await compactsOnThirdTurn({ contextWindow: 300_000, maxTokens: 1_000 })).toBe(false);
  });

  it.each([
    [{ maxTokens: 300_000, contextWindow: 300_000 }, "maxTokens"],
    [{ contextWindow: 0 }, "contextWindow"],
    [{ maxTokens: 1.5 }, "maxTokens"],
  ])("refuses invalid limits %o naming the field", async (limits, field) => {
    await expect(
      startTestAgent(testDefinition({ model: modelOf(undefined, limits) }), { models: undefined }),
    ).rejects.toThrow(field);
  });
});
