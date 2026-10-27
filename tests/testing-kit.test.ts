// The testing kit is how an out-of-tree agent tests itself: only @reework/core and
// @reework/core/testing, no pi-ai or pi-durable imports.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Type, defineTool, definePlugin, gatedAction } from "@reework/core";
import {
  scriptedModel,
  startTestAgent,
  text,
  toolCall,
  waitForIdle,
  waitForProposal,
} from "@reework/core/testing";
import type { AgentDefinition } from "@reework/core";
import { engineOf } from "@reework/core/internal";

const ops = definePlugin("ops", () => ({
  tools: [
    defineTool({
      name: "status",
      description: "Service status",
      parameters: Type.Object({}),
      execute: async () => "degraded",
    }),
    gatedAction({
      name: "restart",
      gate: { title: "Restart the worker?", options: [{ id: "go", label: "Restart" }] },
      run: async () => "worker restarted",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "kit-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "KIT_KEY" }, modelId: "m1" },
  plugins: [{ plugin: ops, config: {} }],
  channels: [],
  mission: { role: "You keep the worker healthy." },
};

describe("the testing kit", () => {
  it("drives a tool, a gated action and the resumed answer end to end", async () => {
    const tokenBefore = process.env.REEWORK_API_TOKEN;
    const model = scriptedModel("m1");
    model.respond([
      toolCall("status", {}),
      toolCall("restart", {}),
      text("asked for approval"),
      text("the worker was restarted"),
    ]);
    const { agent, token, dispose } = await startTestAgent(definition, { models: model.models });
    expect(token).toBeTruthy();
    expect(process.env.REEWORK_API_TOKEN).toBe(tokenBefore);

    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "the worker is slow");
    const proposal = await waitForProposal(agent.host, id);
    expect(proposal.title).toBe("Restart the worker?");

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
    });
    await waitForIdle(agent.host, id);
    const { messages } = await agent.host.snapshot(id);
    expect(JSON.stringify(messages.at(-1))).toContain("the worker was restarted");

    const res = await agent.app.request("/conversations", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    await dispose();
    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
  });

  it("uses a scripted model by default", async () => {
    const { agent, model, dispose } = await startTestAgent(definition);
    model.respond([text("hello")]);
    const { id } = await agent.host.createConversation();
    const { message } = await agent.host.submitInput(id, "hi", { wait: true });
    expect(JSON.stringify(message)).toContain("hello");
    await dispose();
  });
});
