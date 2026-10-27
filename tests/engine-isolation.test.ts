import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, defineTool, gatedAction, listOpenProposals, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent as startKitAgent, toolCall } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import { settleGate, engineOf } from "@reework/core/internal";

import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

const kitAgents: TestAgent[] = [];
afterEach(async () => {
  while (kitAgents.length)
    await kitAgents
      .pop()!
      .dispose()
      .catch(() => {});
});

const enc = (s: string) => new TextEncoder().encode(s);

/** An agent whose plugin calls a named model, adds a file and updates its case. */
function boundDefinition(label: string): AgentDefinition {
  const probe = definePlugin(
    "probe",
    () => ({
      hooks: {
        async beforeModelRequest(_input, ctx) {
          // The hook uses the same per-agent bindings as the tool context.
          await ctx.models.complete("fast", { messages: "hook call" });
        },
      },
      tools: [
        defineTool({
          name: "probe",
          description: "probe",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            const fast = await ctx.models.complete("fast", { messages: "tool call" });
            const file = await ctx.files.add({
              name: "note.txt",
              mimeType: "text/plain",
              bytes: enc("from probe"),
            });
            await ctx.case.update({ stage: "x" });
            return `${fast.text}:${file.name}`;
          },
        }),
      ],
    }),
    { models: ["fast"] },
  );
  return testDefinition({
    name: `bound-${label}`,
    models: {
      fast: {
        provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "REEWORK_TEST_LLM_KEY" },
        modelId: `fast-${label}`,
      },
    },
    plugins: [{ plugin: probe, config: {} }],
  });
}

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

    const [proposalA] = await listOpenProposals(engineOf(a));
    const [proposalB] = await listOpenProposals(engineOf(b));
    expect(proposalA.title).toBe("act for A");
    expect(proposalB.title).toBe("act for B");

    await settleGate(engineOf(a), {
      proposalId: proposalA.id,
      selectedOption: "go",
      instruction: null,
    });
    await settleGate(engineOf(b), {
      proposalId: proposalB.id,
      selectedOption: "go",
      instruction: null,
    });

    await eventually(() => runsA.length + runsB.length === 2, { timeoutMs: 2000 });
    expect(runsA).toEqual(["A:go"]);
    expect(runsB).toEqual(["B:go"]);
  });

  it("binds named models, files and case access to the agent that owns them", async () => {
    const aFast: string[] = [];
    const bFast: string[] = [];
    const a = await startKitAgent(boundDefinition("a"));
    kitAgents.push(a);
    const b = await startKitAgent(boundDefinition("b"));
    kitAgents.push(b);

    // Each named model records which agent's call reached it.
    a.models.fast.respond([
      (context) => {
        aFast.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("fast-a");
      },
    ]);
    b.models.fast.respond([
      (context) => {
        bFast.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("fast-b");
      },
    ]);

    const caseA = await a.agent.host.createConversation();
    const caseB = await b.agent.host.createConversation();

    let secondRequest = "";
    a.model.respond([
      toolCall("probe", {}),
      (context) => {
        secondRequest = JSON.stringify(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);

    await a.agent.host.submitInput(caseA.id, "probe", { wait: true });

    // Agent A's named model took the calls; agent B's took none.
    expect(aFast.length).toBeGreaterThan(0);
    expect(bFast).toEqual([]);

    // The file and the case update landed in A's stores, not B's.
    expect((await a.agent.host.listFiles(caseA.id)).map((f) => f.name)).toEqual(["note.txt"]);
    expect(await b.agent.host.listFiles(caseB.id)).toEqual([]);
    expect((await a.agent.host.getCase(caseA.id)).stage).toBe("x");
    expect((await b.agent.host.getCase(caseB.id)).stage).toBeUndefined();

    // A's request carries A's case in the case section.
    expect(secondRequest).toContain("stage=x");
  });
});
