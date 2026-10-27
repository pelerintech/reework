// The conversation view: what a surface shows, folded from the watch stream (the
// snapshot first, then event batches). Pure — every surface renders from it instead
// of re-deriving the protocol.
import type { AgentEvent, Case, Proposal, TranscriptItem } from "@reework/types";
import type { WatchFrame } from "./index.ts";

export type ViewMessage = Extract<TranscriptItem, { type: "message" }> & {
  /** Stream id of the message, when it arrived live. */
  readonly id?: string;
  /** True while its text is still streaming. */
  readonly streaming: boolean;
};

export type ViewTool = Extract<TranscriptItem, { type: "tool" }>;

export type ViewItem = ViewMessage | ViewTool;

export interface ConversationView {
  readonly conversationId: string;
  /** Messages and tool calls, oldest first. */
  readonly items: readonly ViewItem[];
  /** Whether a run is answering input. */
  readonly running: boolean;
  /** Proposals waiting for a decision. */
  readonly proposals: readonly Proposal[];
  /** The conversation's case, once the snapshot carries it. */
  readonly case?: Case;
}

/** The view before anything has arrived. */
export function emptyView(conversationId: string): ConversationView {
  return { conversationId, items: [], running: false, proposals: [] };
}

/** Fold one watch frame into the view. */
export function applyFrame(view: ConversationView, frame: WatchFrame): ConversationView {
  if (frame.kind === "snapshot") {
    return {
      conversationId: frame.conversationId,
      items: (frame.transcript ?? []).map((item) =>
        item.type === "message" ? { ...item, streaming: false } : { ...item },
      ),
      running: frame.running,
      proposals: [...frame.proposals],
      ...(frame.case ? { case: frame.case } : {}),
    };
  }
  return frame.events.reduce(applyEvent, view);
}

function applyEvent(view: ConversationView, event: AgentEvent): ConversationView {
  switch (event.kind) {
    case "run_start":
      return { ...view, running: true };
    case "run_end":
      return { ...view, running: false, items: view.items.map(endStreaming) };
    case "message_start": {
      const items = view.items.map(endStreaming);
      if ((event.role !== "user" && event.role !== "assistant") || !event.text) {
        return { ...view, items };
      }
      const message: ViewMessage = {
        type: "message",
        role: event.role,
        text: event.text,
        timestamp: event.timestamp,
        id: event.messageId,
        streaming: event.role === "assistant",
      };
      return { ...view, items: [...items, message] };
    }
    case "message_update": {
      if (!event.text) return view;
      const index = view.items.findIndex((i) => i.type === "message" && i.id === event.messageId);
      if (index < 0) {
        const message: ViewMessage = {
          type: "message",
          role: "assistant",
          text: event.text,
          timestamp: event.timestamp,
          id: event.messageId,
          streaming: true,
        };
        return { ...view, items: [...view.items, message] };
      }
      return {
        ...view,
        items: replace(
          view.items,
          index,
          (m) => ({ ...m, text: m.type === "message" ? m.text + event.text : "" }) as ViewItem,
        ),
      };
    }
    case "tool_execution_start": {
      if (view.items.some((i) => i.type === "tool" && i.callId === event.callId)) return view;
      const tool: ViewTool = {
        type: "tool",
        callId: event.callId,
        name: event.name,
        args: event.arguments,
        status: "running",
        startedAt: event.timestamp,
      };
      return { ...view, items: [...view.items.map(endStreaming), tool] };
    }
    case "tool_execution_end": {
      const index = view.items.findIndex((i) => i.type === "tool" && i.callId === event.callId);
      if (index < 0) return view;
      return {
        ...view,
        items: replace(view.items, index, (tool) => ({
          ...(tool as ViewTool),
          status: event.isError ? "error" : "done",
          endedAt: event.timestamp,
        })),
      };
    }
    case "proposal_opened":
      return view.proposals.some((p) => p.id === event.proposal.id)
        ? view
        : { ...view, proposals: [...view.proposals, event.proposal] };
    case "proposal_closed":
      return { ...view, proposals: view.proposals.filter((p) => p.id !== event.proposalId) };
    case "case_updated":
      return { ...view, case: event.case };
    default:
      return view;
  }
}

function endStreaming(item: ViewItem): ViewItem {
  return item.type === "message" && item.streaming ? { ...item, streaming: false } : item;
}

function replace(
  items: readonly ViewItem[],
  index: number,
  change: (item: ViewItem) => ViewItem,
): ViewItem[] {
  return items.map((item, i) => (i === index ? change(item) : item));
}
