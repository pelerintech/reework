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

/** Spend of one named-model call made by a tool or a gated action. */
export interface ModelCallUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Who an input or a decision is from. `id` is stable within the kind (a user name,
 * an integration, a plugin or agent name); `name` is what a surface displays.
 */
export type AuthorKind = "human" | "system" | "agent";

export type Author = {
  readonly kind: AuthorKind;
  readonly id?: string;
  readonly name?: string;
};

const AUTHOR_KINDS: readonly AuthorKind[] = ["human", "system", "agent"];

/** Guard: a well-formed author (`kind` known; `id`/`name` non-empty, at most 200 chars). */
export function isAuthor(value: unknown): value is Author {
  if (typeof value !== "object" || value === null) return false;
  const author = value as Record<string, unknown>;
  if (!AUTHOR_KINDS.includes(author.kind as AuthorKind)) return false;
  for (const field of ["id", "name"] as const) {
    const given = author[field];
    if (given === undefined) continue;
    if (typeof given !== "string" || given.length === 0 || given.length > 200) return false;
  }
  return true;
}

/** Keep only the author's known fields. */
export function normalizeAuthor(author: Author): Author {
  return {
    kind: author.kind,
    ...(author.id === undefined ? {} : { id: author.id }),
    ...(author.name === undefined ? {} : { name: author.name }),
  };
}

/**
 * Token usage of one model response. Tokens only: reework agents use custom
 * endpoints that have no catalog price, so a budget plugin prices them itself.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

/** A single conversation message in the shared reework vocabulary. */
export interface Message {
  role: MessageRole;
  content: MessageContent;
  timestamp: number;
  /** Who the message is from; absent means unattributed, never a human. */
  from?: Author;
}

/** Guard: is this value a pi-ai-style message (`{ role, content }`)? */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.role === "string" && (typeof m.content === "string" || Array.isArray(m.content));
}

// ---------------------------------------------------------------------------
// Model message (what hooks see; reework's own, so no pi-ai type leaks)
// ---------------------------------------------------------------------------

/** A text block inside a model message. */
export interface ModelTextBlock {
  type: "text";
  text: string;
}

/** An image block inside a model message. */
export interface ModelImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** A tool call the assistant issued. */
export interface ModelToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  args: unknown;
}

/** A block rework does not model; it passes through unchanged so a rewrite never drops it. */
export interface ModelOtherBlock {
  type: "other";
  /** The raw pi-ai block, kept as-is for round-tripping. */
  raw: unknown;
}

export type ModelMessageBlock =
  | ModelTextBlock
  | ModelImageBlock
  | ModelToolCallBlock
  | ModelOtherBlock;

/**
 * A message as a hook sees it. `user`/`assistant` are text (assistant may also
 * carry tool-call blocks); `toolResult` carries `toolCallId`, `text` and
 * `isError`. Content that rework does not model rides through as opaque
 * `{ type: "other" }` blocks.
 */
export interface ModelMessage {
  role: "user" | "assistant" | "toolResult" | "system";
  content: string | readonly ModelMessageBlock[];
  /** Present on a `toolResult` message: the call it answers. */
  toolCallId?: string;
  /** Present on a `toolResult` message: the tool that produced it. */
  toolName?: string;
  /** Present on a `toolResult` message: when the result was created. */
  timestamp?: number;
  /** Present on a `toolResult` message: whether the tool failed. */
  isError?: boolean;
  /**
   * Present on a `toolResult` message: the result is outside content. Read from
   * the stored result's `details.reework.external`, so later requests know it.
   */
  external?: boolean;
  /**
   * On a `user` message in a hook's input: who it is from. Absent means
   * unattributed, never a human.
   */
  from?: Author;
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
  | "proposal_opened"
  | "proposal_closed"
  | "case_updated"
  | "snapshot";

export interface AgentEventBase {
  kind: AgentEventKind;
  conversationId: string;
  timestamp: number;
}

export interface MessageStartEvent extends AgentEventBase {
  kind: "message_start";
  messageId: string;
  /** Who the message is from; `assistant` text then streams as `message_update`. */
  role?: MessageRole;
  /** The text a message starts with (a user's input arrives whole). */
  text?: string;
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
  /** Whether the tool failed (it threw, was blocked, or was interrupted). */
  isError: boolean;
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

/** One item of a conversation's transcript: a message, or a tool call with how it went. */
export type TranscriptItem =
  | {
      type: "message";
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      /** Who the message is from; absent means unattributed. */
      from?: Author;
    }
  | {
      type: "tool";
      callId: string;
      name: string;
      args: unknown;
      /** `running` while it executes; a call left without result by an ended run is `error`. */
      status: "running" | "done" | "error";
      startedAt: number;
      endedAt?: number;
    };

/** A gated action asked a human; the proposal waits for a decision. */
export interface ProposalOpenedEvent extends AgentEventBase {
  kind: "proposal_opened";
  proposal: Proposal;
}

/** A proposal was decided and left the open list. */
export interface ProposalClosedEvent extends AgentEventBase {
  kind: "proposal_closed";
  proposalId: string;
  selectedOption: string | null;
  instruction: string | null;
  /** Who decided; absent means unattributed. */
  decidedBy?: Author;
}

/** The conversation's case changed. */
export interface CaseUpdatedEvent extends AgentEventBase {
  kind: "case_updated";
  case: Case;
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
  /** Messages and tool calls so far, oldest first; running calls included. */
  transcript?: TranscriptItem[];
  /** The conversation's case at snapshot time. */
  case?: Case;
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
  | ProposalOpenedEvent
  | ProposalClosedEvent
  | CaseUpdatedEvent
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
export type ProposalAttachment =
  | { kind: "markdown" | "diff" | "text"; title?: string; content: string }
  | {
      kind: "file";
      title?: string;
      fileId: string;
      /** Denormalized at open time so surfaces can show it without a fetch. */
      name?: string;
      mimeType?: string;
      size?: number;
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

/** A decision on a gate: a finite choice and/or a free-form instruction, and who decided. */
export type GateDecision = {
  proposalId: string;
  /** Finite choice offered by the gate, or null when none was selected. */
  selectedOption: string | null;
  /** Open-ended instruction the agent interprets, or null when none was given. */
  instruction: string | null;
  /** Who decided; absent means unattributed (never assumed human). */
  decidedBy?: Author;
};

export function isGateDecision(value: unknown): value is GateDecision {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.proposalId !== "string") return false;
  const hasOption = typeof d.selectedOption === "string";
  const hasInstruction = typeof d.instruction === "string";
  if (d.decidedBy !== undefined && !isAuthor(d.decidedBy)) return false;
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
// Plugin routes
// ---------------------------------------------------------------------------

/** Prefix every plugin-mounted route sits under; a plugin's own paths are relative. */
export const PLUGIN_ROUTE_PREFIX = "/plugins";

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
  health: { method: "GET", path: "/health", auth: "open", summary: "Liveness and the agent name" },
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
  "conversations.getCase": {
    method: "GET",
    path: "/conversations/:id/case",
    auth: "token",
    summary: "A conversation's case",
  },
  "conversations.updateCase": {
    method: "POST",
    path: "/conversations/:id/case",
    auth: "token",
    summary: "Update a conversation's case; 400 naming the invalid field",
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
  "conversations.files": {
    method: "GET",
    path: "/conversations/:id/files",
    auth: "token",
    summary: "A conversation's files",
  },
  "conversations.uploadFile": {
    method: "POST",
    path: "/conversations/:id/files",
    auth: "token",
    summary: "Upload a file; `?name=` names it, Content-Type is its type",
  },
  "conversations.downloadFile": {
    method: "GET",
    path: "/conversations/:id/files/:fid",
    auth: "token",
    summary: "Download a file's bytes as an attachment",
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

// ---------------------------------------------------------------------------
// Cases (conversation = case)
// ---------------------------------------------------------------------------

/** Core-owned lifecycle of a case. `waiting` is set by a writer only. */
export type CaseStatus = "open" | "waiting" | "closed";

export type CasePriority = "low" | "normal" | "high" | "urgent";

/** A conversation's case: what a human sees and works on. */
export interface Case {
  id: string;
  key?: string;
  createdAt: number;
  /** Moves on every case write and on every input submitted to the case. */
  updatedAt: number;
  title?: string;
  summary?: string;
  status: CaseStatus;
  /** Agent-defined label; surfaces show but never interpret it. */
  stage?: string;
  priority: CasePriority;
  tags: string[];
  dueAt?: number;
  closedAt?: number;
  /** Derived from open proposals; never stored. */
  needsHuman: boolean;
  /** Derived from open proposals; never stored. */
  openProposals: number;
}

/** Fields a writer (host, plugin, model tool, HTTP) may change. */
export type CasePatch = Partial<
  Pick<Case, "title" | "summary" | "status" | "stage" | "priority" | "tags" | "dueAt">
>;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A file stored beside the agent's storage, content-addressed by sha256. */
export type FileRecord = {
  id: string;
  conversationId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: number;
  source: "upload" | "plugin";
};
