// Attributed input starts a run like any user input: the budget's rounds are counted
// since the latest user entry, whether it is `pi.user` or `reework.input`.
import { describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, Author } from "@reework/core";
import { startTestAgent, text, toolCall, toolCalls } from "@reework/core/testing";

function definition(): AgentDefinition {
  const plugin = definePlugin("work", () => ({
    tools: [
      defineTool({
        name: "step",
        description: "One step",
        parameters: Type.Object({}),
        execute: async () => "stepped",
      }),
    ],
  }));
  return {
    name: "attributed-budget",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You work in steps." },
    limits: { toolRoundsPerRun: 2 },
  };
}

const from: Author = { kind: "human", name: "Ana" };

describe("attributed input and the run budget", () => {
  it("gives a new attributed input a fresh budget", async () => {
    const { agent, model, dispose } = await startTestAgent(definition());
    const { id } = await agent.host.createConversation();

    // The first run keeps calling tools until the budget refuses the third round.
    model.respond([
      toolCalls([["step"], ["step"]]),
      toolCall("step"),
      toolCall("step"),
      text("first done"),
    ]);
    await agent.host.submitInput(id, "first", { from, wait: true });

    // The second run gets exactly its own two rounds and answers.
    model.respond([toolCall("step"), toolCall("step"), text("second done")]);
    const { message } = await agent.host.submitInput(id, "second", { from, wait: true });
    const content = message?.content;
    const answer =
      typeof content === "string"
        ? content
        : (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");

    expect(answer).toBe("second done");
    await dispose();
  });
});
