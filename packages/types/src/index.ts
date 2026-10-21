// Shared contracts consumed by `core`, `ui`, and externally-installed plugins.

// ---------------------------------------------------------------------------
// Message (derived from pi-ai's Message: OpenAI-style role + content)
// ---------------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** A text content block in a message. */
export interface MessageTextBlock {
  type: "text";
  text: string;
}

export type MessageContentBlock = MessageTextBlock;

/** Message content: a plain string or a list of content blocks. */
export type MessageContent = string | MessageContentBlock[];

/** A single conversation message in the shared reework vocabulary. */
export interface Message {
  role: MessageRole;
  content: MessageContent;
  timestamp: number;
}

/** Guard: is this value a pi-ai-style message (`{ role, content }`)? */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.role === "string" && (typeof m.content === "string" || Array.isArray(m.content));
}

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
  /** User and assistant messages so far, oldest first. */
  messages?: Message[];
  /** Proposals open in the conversation. */
  proposals?: Proposal[];
  /** Whether a run is answering input right now. */
  running?: boolean;
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

/**
 * Material shown with a proposal so the human can decide without leaving the
 * surface. Surfaces that cannot render a kind show it as `text`.
 */
export type ProposalAttachment = {
  kind: "markdown" | "diff" | "text";
  title?: string;
  content: string;
};

export interface Proposal {
  id: string;
  conversationId: string;
  title: string;
  description?: string;
  /** Evidence and proposed changes (diagnosis, logs, a diff, test output). */
  attachments?: ProposalAttachment[];
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
    typeof p.acceptFreeForm === "boolean" &&
    (p.attachments === undefined || Array.isArray(p.attachments))
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
// Conversations and submissions (protocol responses)
// ---------------------------------------------------------------------------

/** `POST /conversations` — 201 when created, 200 when the key already existed. */
export interface ConversationCreated {
  id: string;
  key?: string;
  created: boolean;
}

/** `POST /conversations/:id/messages` — 202: admitted, answered in the background. */
export interface SubmissionAccepted {
  conversationId: string;
  submissionId: string;
}

/** `POST /conversations/:id/messages?wait=true` — 200 with the answer. */
export interface SubmissionAnswered extends SubmissionAccepted {
  message?: Message;
}

// ---------------------------------------------------------------------------
// Route table: every built-in protocol route. The server mounts from it and
// clients call by id, so they cannot drift.
// ---------------------------------------------------------------------------

export interface RouteSpec {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** `token`: needs `Authorization: Bearer <REEWORK_API_TOKEN>`. */
  readonly auth: "token" | "open";
  readonly summary: string;
}

export const ROUTES = {
  health: { method: "GET", path: "/health", auth: "open", summary: "Liveness" },
  "conversations.create": {
    method: "POST",
    path: "/conversations",
    auth: "token",
    summary: "Create a conversation; a `key` makes it idempotent (201 new, 200 existing)",
  },
  "conversations.list": {
    method: "GET",
    path: "/conversations",
    auth: "token",
    summary: "Every created conversation with its key and creation time",
  },
  "conversations.get": {
    method: "GET",
    path: "/conversations/:id",
    auth: "token",
    summary: "A conversation's entries",
  },
  "conversations.submit": {
    method: "POST",
    path: "/conversations/:id/messages",
    auth: "token",
    summary:
      "Submit input (202); `?wait=true` returns the answer; `requestId` dedupes; `mode: steer`",
  },
  "conversations.abort": {
    method: "POST",
    path: "/conversations/:id/abort",
    auth: "token",
    summary: "Stop the current run; open gates stay open",
  },
  "conversations.proposals": {
    method: "GET",
    path: "/conversations/:id/proposals",
    auth: "token",
    summary: "Open proposals of one conversation",
  },
  "conversations.decide": {
    method: "POST",
    path: "/conversations/:id/proposals/:pid/decisions",
    auth: "token",
    summary: "Decide a proposal of this conversation",
  },
  "conversations.watch": {
    method: "GET",
    path: "/conversations/:id/ws",
    auth: "token",
    summary: "WebSocket: a snapshot, then live AgentEvents",
  },
  "proposals.list": {
    method: "GET",
    path: "/proposals",
    auth: "token",
    summary: "Open proposals across every conversation (the inbox)",
  },
  "proposals.decide": {
    method: "POST",
    path: "/proposals/:pid/decisions",
    auth: "token",
    summary: "Decide any open proposal by id",
  },
} as const satisfies Record<string, RouteSpec>;

export type RouteId = keyof typeof ROUTES;

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
