import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, gatedAction } from "@reework/core";
import {
  startTestAgent,
  text,
  toolCall,
  waitForIdle,
  waitForProposal,
} from "@reework/core/testing";
import { testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

/** The agent's app with its generated API token added to every request. */
function appFor(test: {
  readonly agent: {
    readonly app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
  };
  readonly token: string;
}) {
  return {
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${test.token}`);
      return test.agent.app.request(path, { ...init, headers });
    },
  };
}

function gatedAgent(
  run?: (ctx: {
    case: { update(patch: { status: "closed" }): Promise<unknown> };
  }) => Promise<unknown>,
) {
  const plugin = definePlugin("gate", () => ({
    tools: [
      gatedAction({
        name: "act",
        gate: { title: "Act?", options: [{ id: "go", label: "Go" }] },
        async run(ctx) {
          if (run) await run(ctx);
          return "acted";
        },
      }),
    ],
  }));
  return testDefinition({ plugins: [{ plugin, config: {} }] });
}

describe("case lifecycle", () => {
  it("a closed case reopens when input is submitted, and waiting stays waiting", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.updateCase(id, { status: "closed" });
    const closed = await test.agent.host.getCase(id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeDefined();

    await test.agent.host.submitInput(id, "hello", { wait: true });
    const reopened = await test.agent.host.getCase(id);
    expect(reopened.status).toBe("open");
    expect(reopened.closedAt).toBeUndefined();
  });

  it("input to a waiting case leaves it waiting", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.updateCase(id, { status: "waiting" });
    await test.agent.host.submitInput(id, "hello", { wait: true });
    const c = await test.agent.host.getCase(id);
    expect(c.status).toBe("waiting");
  });

  it("refuses to close a case with an open proposal, naming it", async () => {
    const test = await startTestAgent(gatedAgent());
    running.push(test);
    test.model.respond([toolCall("act", {}), text("asked")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "act", { wait: true });
    const proposal = await waitForProposal(test.agent.host, id);

    await expect(test.agent.host.updateCase(id, { status: "closed" })).rejects.toThrow(proposal.id);
    expect((await test.agent.host.getCase(id)).status).toBe("open");

    const app = appFor(test);
    const res = await app.request(`/conversations/${id}/case`, {
      method: "POST",
      body: JSON.stringify({ status: "closed" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(proposal.id);
    expect((await test.agent.host.getCase(id)).status).toBe("open");
  });

  it("a dismissed proposal lets the case close", async () => {
    const test = await startTestAgent(gatedAgent());
    running.push(test);
    test.model.respond([toolCall("act", {}), text("asked"), text("resumed")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "act", { wait: true });
    const proposal = await waitForProposal(test.agent.host, id);
    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: null,
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await waitForIdle(test.agent.host, id);

    await test.agent.host.updateCase(id, { status: "closed" });
    const closed = await test.agent.host.getCase(id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeDefined();
  });

  it("a gated action whose run closes the case keeps it closed on resume", async () => {
    const test = await startTestAgent(
      gatedAgent(async (ctx) => {
        await ctx.case.update({ status: "closed" });
      }),
    );
    running.push(test);
    test.model.respond([toolCall("act", {}), text("asked"), text("resumed")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "act", { wait: true });
    const proposal = await waitForProposal(test.agent.host, id);
    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await waitForIdle(test.agent.host, id);

    const closed = await test.agent.host.getCase(id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeDefined();
  });

  it("input submitted over HTTP reopens a closed case", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    test.model.respond([text("hello back")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.updateCase(id, { status: "closed" });
    expect((await test.agent.host.getCase(id)).closedAt).toBeDefined();

    const app = appFor(test);
    const res = await app.request(`/conversations/${id}/messages?wait=true`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const reopened = await test.agent.host.getCase(id);
    expect(reopened.status).toBe("open");
    expect(reopened.closedAt).toBeUndefined();
  });
});
