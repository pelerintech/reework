import { randomUUID } from "node:crypto";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentEvent as DurableEvent } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@reework/types";

/**
 * Map a pi-durable agent event to the shared reework `AgentEvent` shape
 * (`kind` + `conversationId` + `timestamp`). Event classes that have no
 * reework counterpart (snapshot, inbox_update, submission, etc.) return
 * `undefined` and are dropped by the caller.
 *
 * `state` belongs to one event stream: it remembers the message being streamed, so
 * every `message_update` carries the id of its `message_start`. Use one per stream
 * (`createEventMapper` does).
 */
/** Per-stream memory of the mapper. */
export interface EventMapperState {
  /** Id of the message being streamed. */
  messageId?: string;
}

/** A mapper for one event stream. */
export function createEventMapper(
  conversationId: ConversationId,
): (event: DurableEvent) => AgentEvent | undefined {
  const state: EventMapperState = {};
  return (event) => mapDurableEvent(conversationId, event, state);
}

export function mapDurableEvent(
  conversationId: ConversationId,
  event: DurableEvent,
  state: EventMapperState = {},
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
    case "message_start": {
      state.messageId = messageIdOf(event);
      const message = event.message as { role?: string; content?: unknown };
      const text = textOf(message.content);
      return {
        kind: "message_start",
        conversationId: conv,
        messageId: state.messageId,
        ...(isRole(message.role) ? { role: message.role } : {}),
        ...(text ? { text } : {}),
        timestamp: ts,
      };
    }
    case "message_update":
      state.messageId ??= `msg-${randomUUID()}`;
      return {
        kind: "message_update",
        conversationId: conv,
        messageId: state.messageId,
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
        isError: toolFailed(event),
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

function messageIdOf(event: DurableEvent & { type: "message_start" }): string {
  const message = event.message as { responseId?: string };
  return message.responseId ?? `msg-${randomUUID()}`;
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

function toolFailed(event: { entry?: { model?: readonly unknown[] }; result?: unknown }): boolean {
  const message = event.entry?.model?.[0] as { isError?: unknown } | undefined;
  if (typeof message?.isError === "boolean") return message.isError;
  return (event.result as { isError?: unknown } | undefined)?.isError === true;
}

function isRole(role: unknown): role is "system" | "user" | "assistant" | "tool" {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
}
