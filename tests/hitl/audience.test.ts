// Gate audiences: a gated action declares who may decide (a human by default,
// or a human-or-agent gate), every surface reads the audience from the proposal,
// and a gate admits only the deciders its audience names.
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { createClient } from "@reework/client";
import type { ProtocolError } from "@reework/client";
import { definePlugin, defineTool, gatedAction, Type } from "@reework/core";
import type { OpenProposal } from "@reework/core";
import { Engine, ProposalsDoc } from "@reework/core/internal";
import {
  createMockModels,
  startTestAgent,
  text,
  toolCall,
  waitFor,
  waitForProposal,
} from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import type { Author, Proposal } from "@reework/types";
import { testDefinition, tmpStorage } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

type Definition = Parameters<typeof gatedAction>[0];

/** A plugin whose only action is a `deploy` gate built from `gate`. */
function deployPlugin(gate: Definition["gate"], audience?: Definition["audience"]) {
  return definePlugin("ops", () => ({
    tools: [
      gatedAction({
        name: "deploy",
        gate,
        ...(audience === undefined ? {} : { audience }),
        run: async () => "deployed",
      }),
    ],
  }));
}

/** Open the `deploy` gate on a started agent, returning the conversation and proposal. */
async function openGateOn(test: TestAgent) {
  test.model.append([toolCall("deploy"), text("waiting on you")]);
  const { id } = await test.agent.host.createConversation();
  await test.agent.host.submitInput(id, "ship it", { wait: true });
  const proposal = await waitForProposal(test.agent.host, id);
  return { id, proposal };
}

/** Start an agent with the `deploy` gate and open it, returning the proposal. */
async function openGate(gate: Definition["gate"], audience?: Definition["audience"]) {
  const test = await startTestAgent(
    testDefinition({ plugins: [{ plugin: deployPlugin(gate, audience), config: {} }] }),
  );
  running.push(test);
  const { id, proposal } = await openGateOn(test);
  return { test, id, proposal };
}

/**
 * A plugin with a `deploy` gate and a `relay` tool that settles a proposal through
 * `ctx.cases.decide` as `decidedBy` (unnamed when absent).
 */
function relayPlugin(decidedBy?: Author, audience?: Definition["audience"]) {
  let relayed: string | undefined;
  const plugin = definePlugin(
    "ops",
    () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "yes", label: "Yes" }] },
          ...(audience === undefined ? {} : { audience }),
          run: async () => "deployed",
        }),
        defineTool({
          name: "relay",
          description: "Relays a decision to another case.",
          parameters: Type.Object({ proposalId: Type.String() }),
          async execute(args, ctx) {
            relayed = await ctx
              .cases!.decide({
                proposalId: args.proposalId,
                decision: { selectedOption: "yes", instruction: null },
                ...(decidedBy === undefined ? {} : { decidedBy }),
              })
              .then(
                () => undefined,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              );
            return "relayed";
          },
        }),
      ],
    }),
    { cases: true },
  );
  return { plugin, relayed: () => relayed };
}

interface RelayGate {
  readonly test: TestAgent;
  readonly id: string;
  readonly proposal: Proposal;
  readonly relayed: () => string | undefined;
}

/** Start an agent whose `deploy` gate can also be decided through `ctx.cases.decide`. */
async function relayGate(
  decidedBy?: Author,
  audience?: Definition["audience"],
): Promise<RelayGate> {
  const { plugin, relayed } = relayPlugin(decidedBy, audience);
  const test = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
  running.push(test);
  const { id, proposal } = await openGateOn(test);
  return { test, id, proposal, relayed };
}

/**
 * Assert a decision is refused by the host, HTTP and `ctx.cases.decide`, naming the
 * proposal's audience, and that the proposal stays open.
 */
async function expectRejectedOnEverySurface(gate: RelayGate, decidedBy?: Author): Promise<void> {
  const { test, id, proposal, relayed } = gate;
  const decision = {
    proposalId: proposal.id,
    selectedOption: "yes",
    instruction: null,
    ...(decidedBy === undefined ? {} : { decidedBy }),
  };
  await expect(test.agent.host.submitDecision(decision)).rejects.toThrow(
    `gate audience is ${proposal.audience}`,
  );

  const { port, close } = await test.agent.listen(0);
  const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
  try {
    const error = (await client
      .decide(decision, { conversationId: id })
      .catch((err: ProtocolError) => err)) as ProtocolError;
    expect(error.status).toBe(400);
    expect(String(error.message)).toContain(`gate audience is ${proposal.audience}`);

    test.model.append([toolCall("relay", { proposalId: proposal.id }), text("relayed")]);
    await test.agent.host.submitInput(id, "relay it", { wait: true });
    await waitFor(() => relayed() !== undefined);
    expect(relayed()).toContain(`gate audience is ${proposal.audience}`);
  } finally {
    await close();
  }

  expect((await test.agent.host.listProposals({ conversationId: id })).map((p) => p.id)).toEqual([
    proposal.id,
  ]);
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

  it("rejects an agent decider on a human gate on every surface and leaves it open", async () => {
    const agentAuthor = { kind: "agent" as const, id: "agent:orchestrator" };
    const gate = await relayGate(agentAuthor, "human");
    await expectRejectedOnEverySurface(gate, agentAuthor);
  });

  it("rejects an unnamed decision on both audiences on every surface", async () => {
    for (const audience of ["human", "human-or-agent"] as const) {
      const gate = await relayGate(undefined, audience);
      await expectRejectedOnEverySurface(gate);
    }
  });

  it("rejects a system decider on both audiences on every surface", async () => {
    const systemAuthor = { kind: "system" as const, id: "svc:bot" };
    for (const audience of ["human", "human-or-agent"] as const) {
      const gate = await relayGate(systemAuthor, audience);
      await expectRejectedOnEverySurface(gate, systemAuthor);
    }
  });

  it("settles an agent decider on a human-or-agent gate", async () => {
    const agentAuthor = { kind: "agent" as const, id: "agent:orchestrator" };
    const { test, proposal } = await openGate(
      { title: "Deploy?", options: [{ id: "yes", label: "Yes" }] },
      "human-or-agent",
    );

    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
      decidedBy: agentAuthor,
    });

    const settled = await waitFor(async () =>
      (await test.agent.host.listProposals({ status: "settled" })).find(
        (p) => p.id === proposal.id,
      ),
    );
    expect(settled.audience).toBe("human-or-agent");
    expect(settled.decidedBy).toEqual(agentAuthor);
    expect(settled.decision).toMatchObject({ decidedBy: agentAuthor });
  });

  it("lets a built gate raise the definition's human default", async () => {
    const agentAuthor = { kind: "agent" as const, id: "agent:orchestrator" };
    const { test, proposal } = await openGate(() => ({
      title: "Deploy?",
      audience: "human-or-agent",
      options: [{ id: "yes", label: "Yes" }],
    }));

    expect(proposal.audience).toBe("human-or-agent");
    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
      decidedBy: agentAuthor,
    });
    const settled = await waitFor(async () =>
      (await test.agent.host.listProposals({ status: "settled" })).find(
        (p) => p.id === proposal.id,
      ),
    );
    expect(settled.decidedBy).toEqual(agentAuthor);
  });

  it("settles a human decider on both audiences", async () => {
    const humanAuthor = { kind: "human" as const, name: "Ana" };
    for (const audience of ["human", "human-or-agent"] as const) {
      const { test, proposal } = await openGate(
        { title: "Deploy?", options: [{ id: "yes", label: "Yes" }] },
        audience,
      );

      await test.agent.host.submitDecision({
        proposalId: proposal.id,
        selectedOption: "yes",
        instruction: null,
        decidedBy: humanAuthor,
      });
      const settled = await waitFor(async () =>
        (await test.agent.host.listProposals({ status: "settled" })).find(
          (p) => p.id === proposal.id,
        ),
      );
      expect(settled.audience).toBe(audience);
      expect(settled.decidedBy).toEqual(humanAuthor);
    }
  });
});
