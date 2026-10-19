import { describe, expect, it } from "vitest";
import { mapDurableEvent } from "@reework/core";

/** A fake conversation id (numbers are branded). */
const conv = 1 as unknown as Parameters<typeof mapDurableEvent>[0];

describe("the protocol maps pi-durable events to the shared AgentEvent shape", () => {
  it("maps run events", () => {
    const start = mapDurableEvent(conv, { type: "run_start", inputs: ["s1"] } as never);
    expect(start).toMatchObject({ kind: "run_start", conversationId: "1", runId: "s1" });
    const end = mapDurableEvent(conv, { type: "run_end", inputs: ["s1"] } as never);
    expect(end).toMatchObject({
      kind: "run_end",
      conversationId: "1",
      runId: "s1",
      outcome: "completed",
    });
  });

  it("maps message events and extracts text deltas", () => {
    const start = mapDurableEvent(conv, {
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "r1" },
    } as never);
    expect(start).toMatchObject({ kind: "message_start", messageId: "r1" });

    const update = mapDurableEvent(conv, {
      type: "message_update",
      usage: {},
      changes: [{ type: "text_delta", delta: "hi" }],
    } as never);
    expect(update).toMatchObject({ kind: "message_update", text: "hi" });
  });

  it("maps tool execution events", () => {
    const toolStart = mapDurableEvent(conv, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "ping",
      args: {},
    } as never);
    expect(toolStart).toMatchObject({
      kind: "tool_execution_start",
      callId: "call-1",
      name: "ping",
    });

    const toolUpdate = mapDurableEvent(conv, {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "ping",
      output: { set: "pong" },
    } as never);
    expect(toolUpdate).toMatchObject({
      kind: "tool_execution_update",
      callId: "call-1",
      output: "pong",
    });

    const toolEnd = mapDurableEvent(conv, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ping",
      entry: {},
    } as never);
    expect(toolEnd).toMatchObject({ kind: "tool_execution_end", callId: "call-1" });
  });

  it("maps compaction events and drops unmapped classes", () => {
    const cstart = mapDurableEvent(conv, {
      type: "compaction_start",
      taskId: "t1",
      reason: "long",
      blocking: true,
    } as never);
    expect(cstart).toMatchObject({ kind: "compaction_start", taskId: "t1" });
    const cend = mapDurableEvent(conv, {
      type: "compaction_end",
      taskId: "t1",
      reason: "long",
      error: "boom",
    } as never);
    expect(cend).toMatchObject({ kind: "compaction_end", taskId: "t1", error: "boom" });

    // Classes with no reework counterpart are dropped.
    expect(mapDurableEvent(conv, { type: "snapshot", entries: [] } as never)).toBeUndefined();
    expect(mapDurableEvent(conv, { type: "inbox_update", items: [] } as never)).toBeUndefined();
  });
});
