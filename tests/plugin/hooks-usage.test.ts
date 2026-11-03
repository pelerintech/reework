// Typed model usage: `afterModelResponse` receives reework's own token counts, mapped
// from the endpoint's report, with no pi-ai type and no cost.
import { describe, expect, it, expectTypeOf } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition, ModelUsage, PluginHooks } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";

interface Harness {
  readonly llm: FakeLlm;
  readonly agent: Awaited<ReturnType<typeof startTestAgent>>;
}

async function agentWith(hooks: PluginHooks): Promise<Harness> {
  const llm = await startFakeLlm();
  process.env[KEY_ENV] = "k";
  const plugin = definePlugin("usage", () => ({ hooks }));
  const def: AgentDefinition = {
    name: "usage-agent",
    model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You answer." },
  };
  const agent = await startTestAgent(def, { models: undefined });
  return { llm, agent };
}

describe("typed model usage", () => {
  it("maps the endpoint's usage to ModelUsage without cost", async () => {
    const seen: unknown[] = [];
    const { llm, agent } = await agentWith({
      async afterModelResponse(input) {
        seen.push(input.usage);
      },
    });
    llm.script({ text: "hi", usage: { input: 120, output: 30 } });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "hello", { wait: true });

    expect(seen[0]).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
    });
    expect(seen[0]).not.toHaveProperty("cost");
  });

  it("types the hook's usage as ModelUsage | undefined", () => {
    type UsageParam = Parameters<NonNullable<PluginHooks["afterModelResponse"]>>[0]["usage"];
    expectTypeOf<UsageParam>().toEqualTypeOf<ModelUsage | undefined>();
  });
});
