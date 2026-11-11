import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition, GateDecision } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor, waitForProposal } from "@reework/core/testing";
import { answerProposal, decideGateAnswer } from "@reework/tui";
import type { Proposal } from "@reework/types";

describe("the TUI's gate-answer decision", () => {
  it("answers with an offered option when the input is a single matching option id", () => {
    const proposals: Proposal[] = [
      {
        id: "gate-1",
        conversationId: "1",
        title: "Apply rollback?",
        audience: "human",
        options: [{ id: "rollback", label: "Roll back" }],
        acceptFreeForm: true,
        createdAt: 0,
      },
    ];

    expect(decideGateAnswer("rollback", proposals)).toEqual({
      kind: "option",
      proposalId: "gate-1",
      optionId: "rollback",
    });
  });

  it("gives a free-form instruction to the open gate when the input is not a matching option", () => {
    const proposals: Proposal[] = [
      {
        id: "gate-1",
        conversationId: "1",
        title: "Apply rollback?",
        audience: "human",
        options: [{ id: "rollback", label: "Roll back" }],
        acceptFreeForm: true,
        createdAt: 0,
      },
    ];

    expect(decideGateAnswer("hold off for now", proposals)).toEqual({
      kind: "instruction",
      proposalId: "gate-1",
      instruction: "hold off for now",
    });
  });

  it("returns null when no gate is open, so the input is sent as a message", () => {
    expect(decideGateAnswer("hello", [])).toBeNull();
  });

  it("answers a proposal as a human, and the gated action sees the author", async () => {
    const decisions: GateDecision[] = [];
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "a", label: "A" }] },
          run: async (_ctx, decision) => {
            decisions.push(decision);
            return "deployed";
          },
        }),
      ],
    }));
    const definition: AgentDefinition = {
      name: "answer-agent",
      model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [{ plugin, config: {} }],
      channels: [],
      mission: { role: "You deploy when asked." },
    };
    const test = await startTestAgent(definition);
    test.model.respond([toolCall("deploy"), text("asked"), text("done")]);
    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await test.agent.host.createConversation();
    await client.submit(id, "ship it");
    const proposal = await waitForProposal(test.agent.host, id);

    await answerProposal(client, proposal, "a");
    await waitFor(() => decisions.length > 0);
    expect(decisions[0]?.decidedBy?.kind).toBe("human");
    await test.dispose();
  });
});
