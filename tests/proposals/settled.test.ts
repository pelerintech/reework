// Settled proposals stay readable: a decided proposal carries who decided and the
// decision, is listed by `status: "settled"`, and stays out of the default (open) list.
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin, gatedAction } from "@reework/core";
import type { Proposal } from "@reework/types";
import { startTestAgent, text, toolCall, waitForProposal } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";
import { testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("settled proposals", () => {
  it("lists a decided proposal with its decider and decision, and keeps it out of the open list", async () => {
    const ops = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: {
            title: "Deploy?",
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          },
          run: async () => "deployed",
        }),
      ],
    }));
    const test = await startTestAgent(testDefinition({ plugins: [{ plugin: ops, config: {} }] }));
    running.push(test);
    test.model.respond([toolCall("deploy"), text("waiting on you")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "ship it", { wait: true });
    const proposal = await waitForProposal(test.agent.host, id);
    const decidedBy = { kind: "human" as const, id: "slack:U1", name: "Ana" };

    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
      decidedBy,
    });

    const settled = (await eventually(async () => {
      const found = await test.agent.host.listProposals({ status: "settled" });
      return found.find((p) => p.id === proposal.id);
    }))!;
    expect(settled.decidedBy).toEqual(decidedBy);
    expect(settled.decision).toEqual({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
      decidedBy,
    });

    expect((await test.agent.host.listProposals()).map((p) => p.id)).not.toContain(proposal.id);
    expect(
      (await test.agent.host.listProposals({ conversationId: id, status: "settled" })).map(
        (p) => p.id,
      ),
    ).toContain(proposal.id);
  });
  it("serves settled proposals over HTTP and the client, keeping the open listing unchanged", async () => {
    const ops = definePlugin("ops-http", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: {
            title: "Deploy?",
            options: [{ id: "yes", label: "Yes" }],
          },
          run: async () => "deployed",
        }),
      ],
    }));
    const test = await startTestAgent(testDefinition({ plugins: [{ plugin: ops, config: {} }] }));
    running.push(test);
    test.model.respond([toolCall("deploy"), text("waiting on you")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "ship it", { wait: true });
    const proposal = await waitForProposal(test.agent.host, id);
    const decidedBy = { kind: "human" as const, id: "slack:U1" };
    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
      decidedBy,
    });
    await eventually(async () =>
      (await test.agent.host.listProposals({ status: "settled" })).some(
        (p) => p.id === proposal.id,
      ),
    );

    const app = {
      request(path: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${test.token}`);
        return test.agent.app.request(path, { ...init, headers });
      },
    };
    const settledRes = await app.request("/proposals?status=settled");
    expect(settledRes.status).toBe(200);
    const settled = ((await settledRes.json()) as { proposals: Proposal[] }).proposals;
    expect(settled.find((p) => p.id === proposal.id)).toMatchObject({
      decidedBy,
      decision: { proposalId: proposal.id, selectedOption: "yes", instruction: null },
    });
    const openRes = await app.request("/proposals");
    expect(
      ((await openRes.json()) as { proposals: Proposal[] }).proposals.map((p) => p.id),
    ).not.toContain(proposal.id);
    const perConversation = await app.request(`/conversations/${id}/proposals?status=settled`);
    expect(
      ((await perConversation.json()) as { proposals: Proposal[] }).proposals.map((p) => p.id),
    ).toContain(proposal.id);

    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const viaClient = await client.listProposals({ status: "settled" });
    expect(viaClient.find((p) => p.id === proposal.id)).toMatchObject({
      decidedBy,
      decision: { proposalId: proposal.id, selectedOption: "yes", instruction: null },
    });
    expect((await client.listProposals()).map((p) => p.id)).not.toContain(proposal.id);
    expect(
      (await client.listProposals({ conversationId: id, status: "settled" })).map((p) => p.id),
    ).toContain(proposal.id);
  });
});
