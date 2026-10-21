import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, gatedAction, listOpenProposals, settleGate } from "@reework/core";
import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

/** An agent whose plugin declares a gated action `act` that records into `runs`. */
async function agentRecordingInto(runs: string[], label: string) {
  const plugin = definePlugin("gated", () => ({
    tools: [
      gatedAction({
        name: "act",
        gate: { title: `act for ${label}`, options: [{ id: "go", label: "Go" }] },
        async run(_ctx, decision) {
          runs.push(`${label}:${decision.selectedOption}`);
          return { label };
        },
      }),
    ],
  }));
  const faux = fauxModels();
  faux.respond([
    fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("asked"),
  ]);
  const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
    models: faux.models,
  });
  const conversation = await agent.host.createConversation();
  await agent.host.submitInput(conversation.id, "act now", { wait: true });
  return agent;
}

describe("two agents in one process", () => {
  it("each runs its own gated action and sees only its own proposals", async () => {
    const runsA: string[] = [];
    const runsB: string[] = [];
    const a = await agentRecordingInto(runsA, "A");
    const b = await agentRecordingInto(runsB, "B");

    const [proposalA] = await listOpenProposals(a.engine);
    const [proposalB] = await listOpenProposals(b.engine);
    expect(proposalA.title).toBe("act for A");
    expect(proposalB.title).toBe("act for B");

    await settleGate(a.engine, {
      proposalId: proposalA.id,
      selectedOption: "go",
      instruction: null,
    });
    await settleGate(b.engine, {
      proposalId: proposalB.id,
      selectedOption: "go",
      instruction: null,
    });

    await eventually(() => runsA.length + runsB.length === 2, { timeoutMs: 2000 });
    expect(runsA).toEqual(["A:go"]);
    expect(runsB).toEqual(["B:go"]);
  });
});
