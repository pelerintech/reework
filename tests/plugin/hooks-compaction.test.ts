import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition, PluginHooks } from "@reework/core";
import { startTestAgent, testDefinition } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

/**
 * Three long turns against a small context window: the third input is preceded
 * by a compaction. `hooks` decides the summary (or declines it).
 */
async function runThreeTurns(hooks: PluginHooks): Promise<{ kinds: string[]; raw: string }> {
  const llm = await startFakeLlm();
  llm.script(
    { text: "a ".repeat(50_000), usage: { input: 100 } },
    { text: "b ".repeat(50_000), usage: { input: 26_000 } },
  );
  const plugin = definePlugin("p", () => ({ hooks }));
  const def: AgentDefinition = {
    ...testDefinition(),
    name: "h",
    model: {
      provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV },
      modelId: "m1",
      contextWindow: 40_000,
      maxTokens: 1_000,
    },
    plugins: [{ plugin, config: {} }],
  };
  const agent = await startTestAgent(def, { models: undefined });
  const { id } = await agent.host.createConversation();
  for (const input of ["one", "two", "three"]) {
    await agent.host.submitInput(id, input, { wait: true });
  }
  const { entries } = await agent.host.readConversation(id);
  return { kinds: entries.map((e) => e.kind), raw: JSON.stringify(entries) };
}

describe("plugin hook semantics: beforeCompaction", () => {
  it("uses a plugin-provided summary as the compaction summary", async () => {
    const { kinds, raw } = await runThreeTurns({
      async beforeCompaction() {
        return { summary: "MY CUSTOM SUMMARY" };
      },
    });
    expect(kinds).toContain("pi.compaction");
    expect(raw).toContain("MY CUSTOM SUMMARY");
  });

  it("leaves the conversation uncompacted when beforeCompaction declines", async () => {
    const { kinds } = await runThreeTurns({
      async beforeCompaction() {
        return { decline: true };
      },
    });
    expect(kinds).not.toContain("pi.compaction");
    expect(kinds).toContain("pi.assistant");
  });
});
