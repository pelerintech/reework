// The activity stream reports the agent's intake state: the snapshot carries it,
// pause and resume publish an agent-level event that names no conversation.
import { describe, expect, it } from "vitest";
import type { ActivityFrame, ActivitySnapshot } from "@reework/types";
import { openActivityStream, waitForIdle, waitForProposal } from "@reework/core/testing";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, defineTool, gatedAction } from "@reework/core";
import { TEST_TOKEN, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

function eventOf(frame: ActivityFrame) {
  if (frame.kind !== "event") throw new Error(`expected an event, got ${frame.kind}`);
  return frame.event;
}

/** A tool that blocks until released. */
function slowTool() {
  const waiters: (() => void)[] = [];
  let starts = 0;
  const tool = defineTool({
    name: "slow",
    description: "Takes a while.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      starts += 1;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        waiters.push(resolve);
      });
      return "slow done";
    },
  });
  return {
    tool,
    release: () => {
      for (const waiter of waiters.splice(0)) waiter();
    },
    started: () => starts,
  };
}

describe("the activity stream's agent state", () => {
  it("carries the state in the snapshot and reports pause and resume", async () => {
    const agent = await startTestAgent(testDefinition());
    const client = await openActivityStream(agent, { token: TEST_TOKEN });

    const snapshotFrame = client.frames[0]!;
    if (snapshotFrame.kind !== "snapshot") throw new Error("expected a snapshot");
    expect((snapshotFrame.snapshot as ActivitySnapshot).agent).toEqual({
      paused: false,
      activeRuns: 0,
      heldInputs: 0,
    });

    const paused = await agent.pause();
    const pausedEvent = eventOf(await client.next());
    expect(pausedEvent).toMatchObject({
      kind: "agent_state",
      paused: true,
      pausedAt: paused.pausedAt,
      activeRuns: 0,
      heldInputs: 0,
    });
    expect(typeof pausedEvent.timestamp).toBe("number");

    const resumed = await agent.resume();
    const resumedEvent = eventOf(await client.next());
    expect(resumedEvent).toMatchObject({
      kind: "agent_state",
      paused: false,
      resumedAt: resumed.resumedAt,
      activeRuns: 0,
      heldInputs: 0,
    });

    for (const event of [pausedEvent, resumedEvent]) {
      expect(event).not.toHaveProperty("conversationId");
      expect(event).not.toHaveProperty("key");
      expect(event).not.toHaveProperty("caseKind");
    }

    await client.close();
  });
});

/** The next `agent_state` frame's event, skipping conversation events. */
async function nextAgentState(client: Awaited<ReturnType<typeof openActivityStream>>) {
  for (;;) {
    const event = eventOf(await client.next());
    if (event.kind === "agent_state") return event;
  }
}

describe("a drainer watching the activity stream", () => {
  it("sees rest fall to zero while paused, without reconnecting", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("slow done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "run");
    await eventually(() => slow.started() >= 1);
    const client = await openActivityStream(agent, { token: TEST_TOKEN });

    await agent.pause();
    expect(await nextAgentState(client)).toMatchObject({ paused: true, activeRuns: 1 });
    slow.release();
    expect(await nextAgentState(client)).toMatchObject({ paused: true, activeRuns: 0 });
    await client.close();
  });

  it("reports a continuation run starting while paused", async () => {
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
          async run() {
            return "deployed";
          },
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage("deployed done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "deploy");
    const proposal = await waitForProposal(agent.host, id);
    const client = await openActivityStream(agent, { token: TEST_TOKEN });
    await agent.pause();
    await nextAgentState(client);

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human" },
    });
    let started: { activeRuns: number } | undefined;
    while (started === undefined) {
      const event = await nextAgentState(client);
      if (event.activeRuns > 0) started = event;
    }
    expect(started.activeRuns).toBeGreaterThan(0);
    await waitForIdle(agent.host, id);
    let rested: { activeRuns: number } | undefined;
    while (rested === undefined) {
      const event = await nextAgentState(client);
      if (event.activeRuns === 0) rested = event;
    }
    expect(rested.activeRuns).toBe(0);
    await client.close();
  });

  it("sends agent state to a filtered connection and nothing outside the filter", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("slow done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const a = await agent.host.createConversation({ key: "team/a" });
    const b = await agent.host.createConversation({ key: "other/b" });
    await agent.host.submitInput(b.id, "run");
    await eventually(() => slow.started() >= 1);
    const client = await openActivityStream(agent, { token: TEST_TOKEN, keyPrefix: "team/" });
    await agent.pause();

    const event = await nextAgentState(client);
    expect(event).toMatchObject({ kind: "agent_state", paused: true });
    for (const frame of client.frames) {
      if (frame.kind !== "event") continue;
      if (frame.event.kind === "agent_state") {
        expect(frame.event).not.toHaveProperty("conversationId");
        continue;
      }
      expect(frame.event.conversationId).toBe(a.id);
      expect(frame.event.key).toBe("team/a");
    }
    expect(JSON.stringify(client.frames)).not.toContain(`"conversationId":"${b.id}"`);
    slow.release();
    await client.close();
  });

  it("sends no agent state for a never-paused agent", async () => {
    const agent = await startTestAgent(testDefinition());
    const { id } = await agent.host.createConversation();
    const client = await openActivityStream(agent, { token: TEST_TOKEN });
    await agent.host.submitInput(id, "answer me", { wait: true });

    let ended = false;
    while (!ended) {
      const frame = await client.next();
      if (frame.kind === "event" && frame.event.kind === "run_ended") ended = true;
    }
    expect(client.frames.some((f) => f.kind === "event" && f.event.kind === "agent_state")).toBe(
      false,
    );
    const snapshot = client.frames[0]!;
    if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.snapshot.agent.paused).toBe(false);
    await client.close();
  });
});
