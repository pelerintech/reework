import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { definePlugin, defineTool } from "@reework/core";
import type { AgentMission } from "@reework/core";
import { startTestAgent, testDefinition } from "./support/agent.ts";
import { offeredTools, startFakeLlm } from "./support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

const tool = (name: string) =>
  defineTool({
    name,
    description: `Tool ${name}.`,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return { output: [{ type: "text", text: name }] };
    },
  });

const twoTools = definePlugin("two", () => ({ tools: [tool("a"), tool("b")] }));

async function toolsOffered(mission: AgentMission): Promise<string[]> {
  const llm = await startFakeLlm();
  const agent = await startTestAgent(
    testDefinition({
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      plugins: [{ plugin: twoTools, config: {} }],
      mission,
    }),
    { models: undefined },
  );
  const conversation = await agent.host.createConversation();
  await agent.host.submitInput(conversation.id, "hi", { wait: true });
  return offeredTools(llm.requests[0]);
}

describe("mission.tools", () => {
  it("offers only the listed tools to the model", async () => {
    expect(await toolsOffered({ role: "r", tools: ["a"] })).toEqual(["a"]);
  });

  it("offers every installed tool when omitted", async () => {
    expect((await toolsOffered({ role: "r" })).sort()).toEqual(["a", "b"]);
  });

  it("stops startup naming a tool no plugin provides", async () => {
    await expect(
      startTestAgent(
        testDefinition({
          plugins: [{ plugin: twoTools, config: {} }],
          mission: { role: "r", tools: ["a", "nope"] },
        }),
      ),
    ).rejects.toThrow(/nope/);
  });
});
