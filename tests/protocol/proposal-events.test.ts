// A watching surface learns about proposals from the stream, without polling.
import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import type { AgentEvent } from "@reework/types";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor, waitForProposal } from "@reework/core/testing";

const plugin = definePlugin("ops", () => ({
  tools: [
    gatedAction({
      name: "deploy",
      gate: {
        title: "Deploy?",
        options: [
          { id: "go", label: "Deploy" },
          { id: "no", label: "Skip" },
        ],
      },
      run: async () => "deployed",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "proposals",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You deploy when asked." },
};

describe("proposal events on the conversation stream", () => {
  it("announces a proposal opening and closing with the chosen option", async () => {
    const { agent, model, token, dispose } = await startTestAgent(definition);
    model.respond([toolCall("deploy"), text("asked"), text("deployed it")]);
    const { port, close } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const { id } = await agent.host.createConversation();
    const other = await agent.host.createConversation();

    const events: AgentEvent[] = [];
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "events") events.push(...frame.events);
    });
    const otherEvents: AgentEvent[] = [];
    const otherWatch = await client.watch(other.id, (frame) => {
      if (frame.kind === "events") otherEvents.push(...frame.events);
    });

    await agent.host.submitInput(id, "ship it");
    const proposal = await waitForProposal(agent.host, id);
    const opened = await waitFor(() => events.find((e) => e.kind === "proposal_opened"));
    expect(opened).toMatchObject({
      conversationId: id,
      proposal: { id: proposal.id, title: "Deploy?" },
    });

    await client.decide({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    const closed = await waitFor(() => events.find((e) => e.kind === "proposal_closed"));
    expect(closed).toMatchObject({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
    });
    expect(otherEvents.filter((e) => e.kind.startsWith("proposal_"))).toEqual([]);

    watch.close();
    otherWatch.close();
    await close();
    await dispose();
  });
});
