import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { GateDecision } from "@reework/types";
import { definePlugin, gatedAction, listOpenProposals, settleGate } from "@reework/core";
import type { GatedActionDefinition } from "@reework/core";
import { authedApp, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

/** Start an agent with one gated action, the model scripted by `steps`. */
async function agentWith<T extends TSchema>(
  action: GatedActionDefinition<T>,
  steps: FauxResponseStep[],
) {
  const faux = fauxModels();
  faux.respond(steps);
  const plugin = definePlugin("gated", () => ({ tools: [gatedAction(action)] }));
  const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
    models: faux.models,
  });
  return { agent, faux };
}

const decide = (selectedOption: string | null, instruction: string | null = null) =>
  ({ selectedOption, instruction }) satisfies Omit<GateDecision, "proposalId">;

describe("gated action v2", () => {
  it("passes the model's arguments and the decision to run", async () => {
    const runs: { decision: GateDecision; args: unknown }[] = [];
    const { agent } = await agentWith(
      {
        name: "restart",
        parameters: Type.Object({ target: Type.String() }),
        gate: { title: "Restart?", options: [{ id: "go", label: "Go" }] },
        async run(_ctx, decision, args) {
          runs.push({ decision, args });
          return "restarted";
        },
      },
      [
        fauxAssistantMessage([fauxToolCall("restart", { target: "svc-a" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("asked"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "restart svc-a", { wait: true });

    const [proposal] = await listOpenProposals(agent.engine);
    await settleGate(agent.engine, { proposalId: proposal.id, ...decide("go") });

    await eventually(() => runs.length === 1);
    expect(runs[0].args).toEqual({ target: "svc-a" });
    expect(runs[0].decision.selectedOption).toBe("go");
  });

  it("builds the proposal from the arguments, attachments included", async () => {
    const diff = "--- a/worker.ts\n+++ b/worker.ts\n@@ -1 +1 @@\n-old\n+new";
    const { agent } = await agentWith(
      {
        name: "open_mr",
        parameters: Type.Object({ target: Type.String(), diff: Type.String() }),
        gate: (args) => ({
          title: `Fix ${args.target}`,
          attachments: [{ kind: "diff", title: "Proposed change", content: args.diff }],
          options: [{ id: "open", label: "Open MR" }],
          acceptFreeForm: true,
        }),
        run: async () => "opened",
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", { target: "worker", diff })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("proposed"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "fix it", { wait: true });

    const res = await authedApp(agent).request("/proposals");
    expect(res.status).toBe(200);
    const { proposals } = (await res.json()) as {
      proposals: { title: string; conversationId: string; attachments?: unknown[] }[];
    };
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe("Fix worker");
    expect(proposals[0].conversationId).toBe(id);
    expect(proposals[0].attachments).toEqual([
      { kind: "diff", title: "Proposed change", content: diff },
    ]);
  });

  it("resumes the agent with the decision and the result once run completes", async () => {
    const { agent } = await agentWith(
      {
        name: "open_mr",
        gate: { title: "Open MR?", options: [{ id: "open", label: "Open" }] },
        run: async () => ({ url: "https://git.example/mr/1" }),
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("asked for approval"),
        fauxAssistantMessage("verified the MR"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "fix it", { wait: true });
    const [proposal] = await agent.host.listProposals();
    await settleGate(agent.engine, { proposalId: proposal.id, ...decide("open") });

    await eventually(async () =>
      JSON.stringify(await agent.host.readConversation(id)).includes("verified the MR"),
    );
    const inputs = (await agent.host.readConversation(id)).entries
      .filter((e) => e.kind === "pi.user")
      .map((e) => JSON.stringify(e.model));
    const outcome = inputs.at(-1)!;
    expect(outcome).toContain("open_mr");
    expect(outcome).toContain("open");
    expect(outcome).toContain("https://git.example/mr/1");
  });

  it("hands a free-form instruction to the agent", async () => {
    const { agent } = await agentWith(
      {
        name: "open_mr",
        gate: { title: "Open MR?", options: [{ id: "open", label: "Open" }], acceptFreeForm: true },
        run: async (_ctx, decision) => (decision.instruction ? "revising" : "opened"),
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("asked"),
        fauxAssistantMessage("adding the test"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "fix it", { wait: true });
    const [proposal] = await agent.host.listProposals();
    await settleGate(agent.engine, {
      proposalId: proposal.id,
      ...decide(null, "also add a regression test"),
    });

    await eventually(async () =>
      JSON.stringify(await agent.host.readConversation(id)).includes("adding the test"),
    );
    expect(JSON.stringify((await agent.host.readConversation(id)).entries)).toContain(
      "also add a regression test",
    );
  });

  it("reports a failed run to the agent and ends the action", async () => {
    let attempts = 0;
    const { agent } = await agentWith(
      {
        name: "open_mr",
        gate: { title: "Open MR?", options: [{ id: "open", label: "Open" }] },
        run: async () => {
          attempts += 1;
          throw new Error("boom: remote rejected the push");
        },
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("asked"),
        fauxAssistantMessage("the push failed, investigating"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "fix it", { wait: true });
    const [proposal] = await agent.host.listProposals();
    await settleGate(agent.engine, { proposalId: proposal.id, ...decide("open") });

    await eventually(async () =>
      JSON.stringify(await agent.host.readConversation(id)).includes("investigating"),
    );
    expect(JSON.stringify((await agent.host.readConversation(id)).entries)).toContain(
      "boom: remote rejected the push",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(attempts).toBe(1);
  });

  it("scopes proposals to their conversation", async () => {
    const { agent } = await agentWith(
      {
        name: "act",
        gate: { title: "Act?", options: [{ id: "go", label: "Go" }] },
        run: async () => "ok",
      },
      [
        fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("asked A"),
        fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("asked B"),
      ],
    );
    const a = await agent.host.createConversation();
    const b = await agent.host.createConversation();
    await agent.host.submitInput(a.id, "act in A", { wait: true });
    await agent.host.submitInput(b.id, "act in B", { wait: true });
    const api = authedApp(agent);
    const list = async (path: string) =>
      (
        (await (await api.request(path)).json()) as {
          proposals: { id: string; conversationId: string }[];
        }
      ).proposals;

    expect((await list("/proposals")).map((p) => p.conversationId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    const inA = await list(`/conversations/${a.id}/proposals`);
    expect(inA.map((p) => p.conversationId)).toEqual([a.id]);

    const [proposalB] = await list(`/conversations/${b.id}/proposals`);
    const misrouted = await api.request(
      `/conversations/${a.id}/proposals/${proposalB.id}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectedOption: "go", instruction: null }),
      },
    );
    expect(misrouted.status).toBe(404);
    expect((await list(`/conversations/${b.id}/proposals`)).map((p) => p.id)).toEqual([
      proposalB.id,
    ]);
  });

  it("builds the proposal from an async gate", async () => {
    const readDiff = async (target: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `--- a/${target}\n+++ b/${target}`;
    };
    const { agent } = await agentWith(
      {
        name: "open_mr",
        parameters: Type.Object({ target: Type.String() }),
        gate: async (args) => ({
          title: `Fix ${args.target}`,
          attachments: [{ kind: "diff", content: await readDiff(args.target) }],
          options: [{ id: "open", label: "Open" }],
        }),
        run: async () => "opened",
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", { target: "worker.ts" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("proposed"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "fix it", { wait: true });

    const [proposal] = await agent.host.listProposals();
    expect(proposal.title).toBe("Fix worker.ts");
    expect(proposal.attachments).toEqual([
      { kind: "diff", content: "--- a/worker.ts\n+++ b/worker.ts" },
    ]);
  });

  it("tells the gate which conversation it opens in", async () => {
    const seen: string[] = [];
    const { agent } = await agentWith(
      {
        name: "open_mr",
        gate: (_args, ctx) => {
          seen.push(ctx.conversationId);
          return {
            title: `Fix in ${ctx.conversationId}`,
            options: [{ id: "open", label: "Open" }],
          };
        },
        run: async () => "opened",
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("proposed"),
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "fix it", { wait: true });

    expect(seen).toEqual([id]);
    expect((await agent.host.listProposals())[0].title).toBe(`Fix in ${id}`);
  });

  it("tells the model plainly that nothing has happened until a human decides", async () => {
    const seen: string[] = [];
    const { agent } = await agentWith(
      {
        name: "open_mr",
        gate: { title: "Open MR?", options: [{ id: "open", label: "Open" }] },
        run: async () => "x",
      },
      [
        fauxAssistantMessage([fauxToolCall("open_mr", {})], { stopReason: "toolUse" }),
        (context) => {
          const last = context.messages.at(-1) as { content: { text?: string }[] };
          seen.push(last.content.map((c) => c.text ?? "").join(""));
          return fauxAssistantMessage("waiting");
        },
      ],
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(seen[0]).toMatch(/not been carried out/i);
    expect(seen[0]).toMatch(/human/i);
    expect(seen[0]).toMatch(/new message/i);
  });
});
