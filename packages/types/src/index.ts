// Shared contracts consumed by `core`, `ui`, and externally-installed plugins.

// ---------------------------------------------------------------------------
// Agent / stream events
// ---------------------------------------------------------------------------

export type AgentEventKind =
  | "message_start"
  | "message_update"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "run_start"
  | "run_end"
  | "compaction_start"
  | "compaction_end"
  | "snapshot";

export interface AgentEventBase {
  kind: AgentEventKind;
  conversationId: string;
  timestamp: number;
}

export interface MessageStartEvent extends AgentEventBase {
  kind: "message_start";
  messageId: string;
}

export interface MessageUpdateEvent extends AgentEventBase {
  kind: "message_update";
  messageId: string;
  text: string;
}

export interface ToolExecutionStartEvent extends AgentEventBase {
  kind: "tool_execution_start";
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ToolExecutionUpdateEvent extends AgentEventBase {
  kind: "tool_execution_update";
  callId: string;
  output: string;
}

export interface ToolExecutionEndEvent extends AgentEventBase {
  kind: "tool_execution_end";
  callId: string;
  result?: unknown;
}

export interface RunStartEvent extends AgentEventBase {
  kind: "run_start";
  runId: string;
}

export interface RunEndEvent extends AgentEventBase {
  kind: "run_end";
  runId: string;
  outcome: "completed" | "unanswered";
}

export interface CompactionStartEvent extends AgentEventBase {
  kind: "compaction_start";
  taskId: string;
}

export interface CompactionEndEvent extends AgentEventBase {
  kind: "compaction_end";
  taskId: string;
  error?: string;
}

export interface SnapshotEvent extends AgentEventBase {
  kind: "snapshot";
  events: AgentEvent[];
}

export type AgentEvent =
  | MessageStartEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | RunStartEvent
  | RunEndEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | SnapshotEvent;

export interface AgentEventStream {
  /** The event state at attachment time. */
  readonly snapshot: { events: AgentEvent[] };
  /** Deliver subsequent event batches (one per commit). */
  start(listener: (events: AgentEvent[]) => void): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface ProposalOption {
  id: string;
  label: string;
  description?: string;
}

export interface Proposal {
  id: string;
  conversationId: string;
  title: string;
  description?: string;
  /** Finite set of offered choices each mapping to a branch. */
  options: ProposalOption[];
  /** Whether the gate also accepts a free-form instruction. */
  acceptFreeForm: boolean;
  createdAt: number;
}

export function isProposal(value: unknown): value is Proposal {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.conversationId === "string" &&
    typeof p.title === "string" &&
    Array.isArray(p.options) &&
    typeof p.acceptFreeForm === "boolean"
  );
}

// ---------------------------------------------------------------------------
// Gate decision records (business-flow-driven)
// ---------------------------------------------------------------------------

/** A human decision on a gate: a finite choice and/or a free-form instruction. */
export type GateDecision = {
  proposalId: string;
  /** Finite choice offered by the gate, or null when none was selected. */
  selectedOption: string | null;
  /** Open-ended instruction the agent interprets, or null when none was given. */
  instruction: string | null;
};

export function isGateDecision(value: unknown): value is GateDecision {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.proposalId !== "string") return false;
  const hasOption = typeof d.selectedOption === "string";
  const hasInstruction = typeof d.instruction === "string";
  return hasOption || hasInstruction;
}

// ---------------------------------------------------------------------------
// Channel contract (separate REST + WS transport surfaces)
// ---------------------------------------------------------------------------

export interface InboundMessage {
  conversationId: string;
  text: string;
}

export interface SendMessageResult {
  conversationId: string;
  result: string;
}

export interface ConversationSummary {
  id: string;
  entries: unknown[];
}

/** REST surface of a channel: request/response message + conversation reads. */
export interface ChannelRestContract {
  sendMessage(input: InboundMessage): Promise<SendMessageResult>;
  getConversation(conversationId: string): Promise<ConversationSummary>;
}

/** WebSocket surface of a channel: live event streaming. */
export interface ChannelWsContract {
  watchEvents(
    conversationId: string,
    listener: (events: AgentEvent[]) => void,
  ): Promise<AgentEventStream>;
}

export type ChannelId = string;

export interface Channel {
  readonly id: ChannelId;
  readonly rest: ChannelRestContract;
  readonly ws: ChannelWsContract;
}

export function isChannel(value: unknown): value is Channel {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.rest === "object" &&
    c.rest !== null &&
    typeof c.ws === "object" &&
    c.ws !== null
  );
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.kind === "string" &&
    typeof e.conversationId === "string" &&
    typeof e.timestamp === "number"
  );
}
