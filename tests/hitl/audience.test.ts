// Gate audiences: a gated action declares who may decide (a human by default,
// or a human-or-agent gate), every surface reads the audience from the proposal,
// and an agent decider is rejected on a human gate.
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { definePlugin, gatedAction } from "@reework/core";
import type { OpenProposal } from "@reework/core";
import { Engine, ProposalsDoc } from "@reework/core/internal";
import {
  createMockModels,
  startTestAgent,
  text,
  toolCall,
  waitForProposal,
} from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import { testDefinition, tmpStorage } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

/** A plugin whose only action is a `deploy` gate built from `gate`. */
function deployPlugin(gate: Parameters<typeof gatedAction>[0]["gate"]) {
  return definePlugin("ops", () => ({
    tools: [
      gatedAction({
        name: "deploy",
        gate,
        run: async () => "deployed",
      }),
    ],
  }));
}

/** Start an agent with the `deploy` gate and open it, returning the proposal. */
async function openGate(gate: Parameters<typeof gatedAction>[0]["gate"]) {
  const test = await startTestAgent(
    testDefinition({ plugins: [{ plugin: deployPlugin(gate), config: {} }] }),
  );
  running.push(test);
  test.model.respond([toolCall("deploy"), text("waiting on you")]);
  const { id } = await test.agent.host.createConversation();
  await test.agent.host.submitInput(id, "ship it", { wait: true });
  const proposal = await waitForProposal(test.agent.host, id);
  return { test, id, proposal };
}

describe("gate audiences", () => {
  it("opens a gate without an audience as a human gate", async () => {
    const { test, id, proposal } = await openGate({
      title: "Deploy?",
      options: [{ id: "yes", label: "Yes" }],
    });

    expect(proposal.audience).toBe("human");
    const listed = await test.agent.host.listProposals({ conversationId: id });
    expect(listed[0]?.audience).toBe("human");
    const snapshot = await test.agent.host.snapshot(id);
    expect(snapshot.proposals?.[0]?.audience).toBe("human");
  });

  it("reads a stored proposal without an audience as a human gate", async () => {
    const storagePath = tmpStorage();
    const engine = await Engine.open({
      storagePath,
      models: createMockModels().models,
      registry: createRegistry(),
    });
    await engine.commit(async (tx) => {
      const doc = (await tx.doc(ProposalsDoc)) as { proposals: OpenProposal[] };
      doc.proposals.push({
        id: "legacy-proposal",
        conversationId: "legacy-conversation",
        title: "Approve?",
        options: [{ id: "yes", label: "Yes" }],
        acceptFreeForm: false,
        createdAt: 1,
        status: "open",
      });
    });
    await engine.close();

    const test: TestAgent = await startTestAgent(testDefinition(), { storagePath });
    running.push(test);
    const listed = (await test.agent.host.listProposals()).find((p) => p.id === "legacy-proposal");
    expect(listed?.audience).toBe("human");
  });
});
