import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentEvent as DurableEvent } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@reework/types";

/**
 * Map a pi-durable agent event to the shared reework `AgentEvent` shape
 * (`kind` + `conversationId` + `timestamp`). Event classes that have no
 * reework counterpart (snapshot, inbox_update, submission, etc.) return
 * `undefined` and are dropped by the caller.
 */
export function mapDurableEvent(
  conversationId: ConversationId,
  event: DurableEvent,
): AgentEvent | undefined {
  const conv = String(conversationId);
  const ts = Date.now();

  switch (event.type) {
    case "run_start":
      return {
        kind: "run_start",
        conversationId: conv,
        runId: String(event.inputs[0] ?? ""),
        timestamp: ts,
      };
    case "run_end":
      return {
        kind: "run_end",
        conversationId: conv,
        runId: String(event.inputs[0] ?? ""),
        outcome: "completed",
        timestamp: ts,
      };
    case "message_start":
      return {
        kind: "message_start",
        conversationId: conv,
        messageId: messageIdOf(event),
        timestamp: ts,
      };
    case "message_update":
      return {
        kind: "message_update",
        conversationId: conv,
        messageId: messageIdOf(event),
        text: messageUpdateText(event),
        timestamp: ts,
      };
    case "tool_execution_start":
      return {
        kind: "tool_execution_start",
        conversationId: conv,
        callId: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        timestamp: ts,
      };
    case "tool_execution_update":
      return {
        kind: "tool_execution_update",
        conversationId: conv,
        callId: event.toolCallId,
        output: toolUpdateOutput(event),
        timestamp: ts,
      };
    case "tool_execution_end":
      return {
        kind: "tool_execution_end",
        conversationId: conv,
        callId: event.toolCallId,
        result: event.entry,
        timestamp: ts,
      };
    case "compaction_start":
      return {
        kind: "compaction_start",
        conversationId: conv,
        taskId: String(event.taskId),
        timestamp: ts,
      };
    case "compaction_end":
      return {
        kind: "compaction_end",
        conversationId: conv,
        taskId: String(event.taskId),
        error: event.error,
        timestamp: ts,
      };
    default:
      return undefined;
  }
}

function messageIdOf(event: DurableEvent): string {
  if (event.type === "message_start") {
    const message = event.message as { responseId?: string };
    return message.responseId ?? `msg-${Date.now()}`;
  }
  if (event.type === "message_update") {
    return `msg-${Date.now()}`;
  }
  return `msg-${Date.now()}`;
}

function messageUpdateText(event: {
  changes?: readonly { type: string; delta?: string }[];
}): string {
  const changes = event.changes ?? [];
  return changes
    .filter((c) => c.type === "text_delta")
    .map((c) => c.delta ?? "")
    .join("");
}

function toolUpdateOutput(event: {
  output?: { trimStart?: number; append?: string } | { set: string } | string;
}): string {
  const output = event.output;
  if (typeof output === "string") return output;
  if (!output) return "";
  if ("set" in output) return output.set;
  return output.append ?? "";
}
