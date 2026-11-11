// The `ctx.cases` capability: a plugin declares `{ cases: true }` to list, read,
// snapshot, submit input to, decide and update other cases as a principal. Event
// hooks get the same capability; a plugin that does not declare it gets none.
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, gatedAction, Type } from "@reework/core";
import type { Author, Case } from "@reework/types";
import type { ConversationSnapshot } from "@reework/core";
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

interface Captured {
  listed?: Case[];
  got?: Case;
  snapshot?: ConversationSnapshot;
  submissionId?: string;
  updated?: Case;
  closeError?: string;
  decided?: boolean;
  decidedBy?: Author;
  eventCases?: boolean;
  eventListed?: string[];
  plainCases?: unknown;
}

describe("ctx.cases", () => {
  it("lets a declaring plugin reach other cases as a principal, in tools and event hooks", async () => {
    const principal: Author = { kind: "human", id: "principal:ana" };
    const captured: Captured = {};
    const deskPlugin = definePlugin(
      "desk",
      () => ({
        tools: [
          gatedAction({
            name: "approve",
            gate: { title: "Approve?", options: [{ id: "yes", label: "Yes" }] },
            run: async () => "approved",
          }),
          defineTool({
            name: "work",
            description: "Works the desk: reads, submits, updates and decides other cases.",
            parameters: Type.Object({
              caseId: Type.String(),
              proposalId: Type.String(),
            }),
            async execute(args, ctx) {
              const cases = ctx.cases!;
              captured.listed = await cases.list({ kind: ["case"] });
              captured.got = await cases.get(args.caseId);
              captured.snapshot = await cases.snapshot(args.caseId);
              captured.submissionId = (
                await cases.submit(args.caseId, "from desk", { from: principal })
              ).submissionId;
              captured.updated = await cases.update(args.caseId, { owner: principal });
              captured.closeError = await cases
                .update(ctx.conversationId, { status: "closed" })
                .then(
                  () => undefined,
                  (error: unknown) => (error instanceof Error ? error.message : String(error)),
                );
              await cases.decide({
                proposalId: args.proposalId,
                decision: { selectedOption: "yes", instruction: null },
                decidedBy: principal,
              });
              captured.decided = true;
              return "worked";
            },
          }),
        ],
        hooks: {
          async onInput(_input, ctx) {
            if (!ctx.cases) return;
            captured.eventCases = true;
            captured.eventListed = (await ctx.cases.list({ kind: ["case"] })).map((c) => c.id);
          },
          async onDecision({ decision }) {
            captured.decidedBy = decision.decidedBy;
          },
        },
      }),
      { cases: true },
    );
    const test = await startTestAgent(
      testDefinition({ plugins: [{ plugin: deskPlugin, config: {} }] }),
    );
    running.push(test);

    const a = await test.agent.host.createConversation({ key: "a" });
    const b = await test.agent.host.createConversation({ key: "b" });
    const desk = await test.agent.host.createConversation({ key: "desk", kind: "desk" });

    test.model.respond([toolCall("approve"), text("waiting on you")]);
    await test.agent.host.submitInput(b.id, "ask", { wait: true });
    const proposal = await waitForProposal(test.agent.host, b.id);

    test.model.append([
      toolCall("work", { caseId: b.id, proposalId: proposal.id }),
      text("worked"),
      text("resumed"),
    ]);
    await test.agent.host.submitInput(desk.id, "work it", { wait: true });

    expect(captured.listed?.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(captured.got?.id).toBe(b.id);
    expect(captured.snapshot?.conversationId).toBe(b.id);
    expect(captured.submissionId).toBeTruthy();
    const read = await test.agent.host.readConversation(b.id);
    expect(JSON.stringify(read.entries)).toContain("from desk");
    expect(JSON.stringify(read.entries)).toContain("principal:ana");
    expect(captured.updated?.owner).toEqual(principal);
    expect((await test.agent.host.getCase(b.id)).owner).toEqual(principal);
    expect(captured.closeError).toMatch(/cannot close a desk/);
    expect(captured.decided).toBe(true);

    await eventually(() => captured.decidedBy !== undefined);
    expect(captured.decidedBy).toEqual(principal);
    expect((await test.agent.host.listProposals()).map((p) => p.id)).not.toContain(proposal.id);

    expect(captured.eventCases).toBe(true);
    await eventually(() => captured.eventListed?.includes(b.id));
  }, 20_000);

  it("gives a plugin without the declaration no cases member", async () => {
    const captured: Captured = {};
    const plain = definePlugin("plain", () => ({
      tools: [
        defineTool({
          name: "check",
          description: "Checks its context.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_args, ctx) {
            captured.plainCases = ctx.cases;
            return "checked";
          },
        }),
      ],
    }));
    const test = await startTestAgent(testDefinition({ plugins: [{ plugin: plain, config: {} }] }));
    running.push(test);
    test.model.respond([toolCall("check"), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go", { wait: true });
    expect(captured.plainCases).toBeUndefined();
  });
});
