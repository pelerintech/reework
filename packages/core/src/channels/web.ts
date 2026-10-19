import { watchEvents } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  AgentEventStream,
  Channel,
  ConversationSummary,
  InboundMessage,
  SendMessageResult,
} from "@reework/types";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";

/** Route-adapter conversation ids are strings; harness ids are branded numbers. */
function toConversationId(id: string): ConversationId {
  return Number(id) as unknown as ConversationId;
}

/** Defensive stringification of an unknown value (avoids `String` on objects). */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Map a pi-durable agent event to a reework `AgentEvent`, or null to drop it. */
function toReworkEvent(
  event: unknown,
  conversationId: string,
  timestamp: number,
): AgentEvent | null {
  const e = event as { type?: string } & Record<string, unknown>;
  const base = { conversationId, timestamp };
  switch (e.type) {
    case "message_start":
      return {
        kind: "message_start",
        ...base,
        messageId: str((e.message as { id?: unknown })?.id),
      };
    case "message_update":
      return {
        kind: "message_update",
        ...base,
        messageId: str((e.message as { id?: unknown })?.id),
        text: "",
      };
    case "tool_execution_start":
      return {
        kind: "tool_execution_start",
        ...base,
        callId: str(e.toolCallId),
        name: str(e.toolName),
        arguments: e.args,
      };
    case "tool_execution_update":
      return { kind: "tool_execution_update", ...base, callId: str(e.toolCallId), output: "" };
    case "tool_execution_end":
      return { kind: "tool_execution_end", ...base, callId: str(e.toolCallId) };
    case "run_start":
      return { kind: "run_start", ...base, runId: conversationId };
    case "run_end":
      return { kind: "run_end", ...base, runId: conversationId, outcome: "completed" };
    case "compaction_start":
      return { kind: "compaction_start", ...base, taskId: str(e.taskId) };
    case "compaction_end":
      return { kind: "compaction_end", ...base, taskId: str(e.taskId), error: undefined };
    case "snapshot":
      return { kind: "snapshot", ...base, events: [] };
    default:
      return null;
  }
}

function toReworkEvents(events: readonly unknown[], conversationId: string): AgentEvent[] {
  const now = Date.now();
  return events
    .map((e) => toReworkEvent(e, conversationId, now))
    .filter((e): e is AgentEvent => e !== null);
}

/** The web channel: a transport adapter above the engine, exposing REST + WS. */
export class WebChannel implements Channel {
  readonly id = "web";

  constructor(private readonly engine: Engine) {}

  readonly rest = {
    sendMessage: async (input: InboundMessage): Promise<SendMessageResult> => {
      const result = await this.engine.run(input.text);
      return { conversationId: input.conversationId, result };
    },
    getConversation: async (id: string): Promise<ConversationSummary> => {
      const root = await this.engine.root();
      return {
        id,
        entries: [...(await root.entries({ order: "descending" }, 50, undefined, CONTEXT)).items],
      };
    },
  };

  readonly ws = {
    watchEvents: async (
      conversationId: string,
      listener: (events: AgentEvent[]) => void,
    ): Promise<AgentEventStream> => {
      const stream = await watchEvents(
        this.engine.harness,
        toConversationId(conversationId),
        CONTEXT,
      );
      const snapshot = { events: toReworkEvents([stream.snapshot], conversationId) };
      stream.start(async (events) => {
        listener(toReworkEvents(events, conversationId));
      });
      return {
        snapshot,
        start: async () => {},
      };
    },
  };
}
