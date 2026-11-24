// The activity stream reports the agent's intake state: the snapshot carries it,
// pause and resume publish an agent-level event that names no conversation.
import { describe, expect, it } from "vitest";
import type { ActivityFrame, ActivitySnapshot } from "@reework/types";
import { openActivityStream } from "@reework/core/testing";
import { TEST_TOKEN, startTestAgent, testDefinition } from "./support/agent.ts";

function eventOf(frame: ActivityFrame) {
  if (frame.kind !== "event") throw new Error(`expected an event, got ${frame.kind}`);
  return frame.event;
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
