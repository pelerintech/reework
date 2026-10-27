import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
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

describe("named model concurrency", () => {
  it("a named model with maxConcurrentRequests:1 serializes parallel calls", async () => {
    const llmFast = await startFakeLlm();
    const llmConv = await startFakeLlm();
    process.env["K"] = "k";

    const call = definePlugin(
      "call",
      () => ({
        tools: [
          defineTool({
            name: "call",
            description: "call",
            parameters: Type.Object({ id: Type.String() }),
            async execute(_args, ctx) {
              const result = await ctx.models.complete("fast", { messages: "x" });
              return result.text;
            },
          }),
        ],
      }),
      { models: ["fast"] },
    );

    const def: AgentDefinition = {
      name: "nm",
      model: { provider: { baseUrl: llmConv.url, apiKeyEnv: "K" }, modelId: "m1" },
      models: {
        fast: {
          provider: { baseUrl: llmFast.url, apiKeyEnv: "K" },
          modelId: "f",
          maxConcurrentRequests: 1,
        },
      },
      plugins: [{ plugin: call, config: {} }],
      channels: [],
      mission: { role: "r" },
    };

    const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
    running.push({ dispose: () => agent.stop() });
    const { id } = await agent.host.createConversation();

    // Two "call" tool calls in ONE parallel round; the fast endpoint replies
    // slowly, so two in-flight would overlap if the cap did not serialize.
    llmConv.script(
      {
        toolCalls: [
          { name: "call", args: { id: "1" } },
          { name: "call", args: { id: "2" } },
        ],
      },
      { text: "done" },
    );
    llmFast.script({ text: "a", delayMs: 120 }, { text: "b", delayMs: 120 });

    await agent.host.submitInput(id, "go", { wait: true });

    // The server never saw more than one concurrent request to `fast`.
    expect(llmFast.load.peak).toBe(1);
    expect(llmFast.requests.length).toBe(2);
    // The conversation model was not held hostage by the fast-round (its own server).
    expect(llmConv.requests.length).toBeGreaterThanOrEqual(1);
  });
});
