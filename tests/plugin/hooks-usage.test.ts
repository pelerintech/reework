// Typed model usage: `afterModelResponse` receives reework's own token counts, mapped
// from the endpoint's report, with no pi-ai type and no cost.
import { describe, expect, it, expectTypeOf } from "vitest";
import { definePlugin } from "@reework/core";
import { toExtension } from "@reework/core/internal";
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

/**
 * The message the facade hands to `afterModelResponse`, built from a provider message that
 * carries no usage object at all. The agent path cannot produce one (pi-durable's usage
 * ledger needs the counters), so this drives the facade's own hook conversion.
 */
type AfterResponse = (
  message: { content: unknown[]; provider: string; model: string },
  api: unknown,
  context: unknown,
) => Promise<void>;

function afterResponseHook(hooks: PluginHooks): AfterResponse {
  const extension = toExtension("usage", { hooks });
  const registration = extension.hooks?.find(
    (h) => typeof (h.handlers as Record<string, unknown>).afterResponse === "function",
  );
  if (!registration) throw new Error("the facade registered no afterResponse hook");
  return (registration.handlers as { afterResponse: AfterResponse }).afterResponse;
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

  it("still runs the hook with usage undefined when the message has no usage", async () => {
    const seen: (ModelUsage | undefined)[] = [];
    const hook = afterResponseHook({
      async afterModelResponse(input) {
        seen.push(input.usage);
      },
    });
    const api = { conversationId: "c1", memo: async () => undefined };

    await hook({ content: [], provider: "p", model: "m" }, api, {});

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });

  it("types the hook's usage as ModelUsage | undefined", () => {
    type UsageParam = Parameters<NonNullable<PluginHooks["afterModelResponse"]>>[0]["usage"];
    expectTypeOf<UsageParam>().toEqualTypeOf<ModelUsage | undefined>();
  });
});
