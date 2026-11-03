// Decision attribution: every gate decision records who decided, carried to the action,
// the watch event and the resumed message, and kept across a restart.
import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import type { ProtocolError } from "@reework/client";
import type { AgentEvent } from "@reework/types";
import { definePlugin, gatedAction, InvalidAuthor } from "@reework/core";
import type { AgentDefinition, GateDecision } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor, waitForProposal } from "@reework/core/testing";
import { tmpStorage } from "../support/agent.ts";

/** Every decision the gated action's `run` saw, oldest first. */
let recorded: GateDecision[] = [];

function definition(): AgentDefinition {
  const plugin = definePlugin("ops", () => ({
    tools: [
      gatedAction({
        name: "deploy",
        gate: {
          title: "Deploy?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        run: async (_ctx, decision) => {
          recorded.push(decision);
          return "deployed";
        },
      }),
    ],
  }));
  return {
    name: "decider",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You deploy when asked." },
  };
}

/** Start a served agent, open its gate, and return the client and conversation. */
async function openGate() {
  recorded = [];
  const test = await startTestAgent(definition());
  test.model.respond([toolCall("deploy"), text("waiting on you"), text("done")]);
  const { port, close } = await test.agent.listen(0);
  const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
  const { id } = await test.agent.host.createConversation();
  const events: AgentEvent[] = [];
  const watch = await client.watch(id, (frame) => {
    if (frame.kind === "events") events.push(...frame.events);
  });
  await client.submit(id, "ship it");
  const proposal = await waitForProposal(test.agent.host, id);
  return { test, client, id, proposal, events, close, watch };
}

/** The text of the gated action's resumed input, as stored. */
async function resumedText(
  agent: Awaited<ReturnType<typeof startTestAgent>>["agent"],
  id: string,
): Promise<string> {
  const { entries } = await agent.host.readConversation(id);
  return entries
    .flatMap((entry) =>
      (entry.model ?? []).map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      ),
    )
    .join("\n");
}

describe("decision attribution", () => {
  it("carries decidedBy to the action, the watch event and the resumed message", async () => {
    const { test, client, id, proposal, events, close, watch } = await openGate();
    const decidedBy = { kind: "human" as const, name: "Ana" };

    await client.decide(
      { proposalId: proposal.id, selectedOption: "a", instruction: null, decidedBy },
      { conversationId: id },
    );

    await waitFor(() => recorded.length > 0);
    expect(recorded[0]?.decidedBy).toEqual(decidedBy);
    const closed = await waitFor(() => events.find((e) => e.kind === "proposal_closed"));
    expect(closed.kind === "proposal_closed" ? closed.decidedBy : undefined).toEqual(decidedBy);
    await waitFor(async () => (await resumedText(test.agent, id)).includes("Ana decided"));
    expect(await resumedText(test.agent, id)).toContain('Ana decided (option "a")');

    watch.close();
    await close();
    await test.dispose();
  });

  it("names the decider by kind when no name or id is given", async () => {
    const { test, client, id, proposal, close, watch } = await openGate();

    await client.decide(
      {
        proposalId: proposal.id,
        selectedOption: "a",
        instruction: null,
        decidedBy: { kind: "human" },
      },
      { conversationId: id },
    );

    await waitFor(async () => (await resumedText(test.agent, id)).includes("A human decided"));
    watch.close();
    await close();
    await test.dispose();
  });

  it("says Someone decided when no author was recorded", async () => {
    const { test, client, id, proposal, close, watch } = await openGate();

    await client.decide(
      { proposalId: proposal.id, selectedOption: "a", instruction: null },
      { conversationId: id },
    );

    const stored = await waitFor(async () => {
      const text = await resumedText(test.agent, id);
      return text.includes("Someone decided") ? text : undefined;
    });
    expect(stored).toContain("Someone decided");
    expect(stored).not.toContain("The human decided");

    watch.close();
    await close();
    await test.dispose();
  });

  it("refuses an invalid decider and leaves the proposal open", async () => {
    const { test, client, id, proposal, close, watch } = await openGate();

    const error = (await client
      .decide(
        {
          proposalId: proposal.id,
          selectedOption: "a",
          instruction: null,
          decidedBy: { kind: "boss" } as unknown as GateDecision["decidedBy"],
        },
        { conversationId: id },
      )
      .catch((err: ProtocolError) => err)) as ProtocolError;
    expect(error.status).toBe(400);
    expect(String(error.message)).toContain("invalid_author");
    expect((await test.agent.host.listProposals({ conversationId: id })).map((p) => p.id)).toEqual([
      proposal.id,
    ]);
    await expect(
      test.agent.host.submitDecision({
        proposalId: proposal.id,
        selectedOption: "a",
        instruction: null,
        decidedBy: { kind: "boss" } as unknown as GateDecision["decidedBy"],
      }),
    ).rejects.toBeInstanceOf(InvalidAuthor);

    watch.close();
    await close();
    await test.dispose();
  });

  it("keeps decidedBy across a restart before the action runs", async () => {
    const storagePath = tmpStorage();
    const decidedBy = { kind: "agent" as const, id: "supervisor" };

    const first = await startTestAgent(definition(), { storagePath });
    first.model.respond([toolCall("deploy"), text("waiting on you")]);
    const { id } = await first.agent.host.createConversation();
    await first.agent.host.submitInput(id, "ship it");
    const proposal = await waitForProposal(first.agent.host, id);
    // Stop before any decision: the gated action is still suspended durably.
    await first.agent.stop();

    recorded = [];
    const second = await startTestAgent(definition(), { storagePath });
    second.model.respond([text("done")]);
    await second.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "a",
      instruction: null,
      decidedBy,
    });

    await waitFor(() => recorded.length > 0);
    expect(recorded[0]?.decidedBy).toEqual(decidedBy);
    await second.dispose();
  });
});
