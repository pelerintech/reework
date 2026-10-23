import { configure } from "@earendil-works/pi-durable";
import type { AgentChange, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { Message, Proposal, TranscriptItem } from "@reework/types";
import type { Engine } from "./engine.ts";
import { CONTEXT } from "./engine.ts";
import { ConversationsDoc } from "./protocol/conversations.ts";
import { listOpenProposals } from "./protocol/proposals.ts";
import { settleGate } from "./hitl/gate.ts";
import type { GateDecision } from "@reework/types";
import type { ConversationRecord } from "./protocol/conversations.ts";
import type { WorkspaceProvider } from "./tooling/facade.ts";

/** A conversation as the protocol sees it. Ids are strings on the wire. */
export interface ConversationInfo {
  readonly id: string;
  readonly key?: string;
  /** False when an existing conversation was returned for its key. */
  readonly created: boolean;
}

export interface CreateConversationOptions {
  /** Idempotency key: the same key always returns the same conversation. */
  readonly key?: string;
}

export interface SubmitOptions {
  /** Wait for the run to answer and return the assistant message. */
  readonly wait?: boolean;
  /** Deduplication key: a repeat returns the original submission and admits nothing. */
  readonly requestId?: string;
  /**
   * While a run is active: `followUp` (default) queues the input for after it;
   * `steer` takes it into the current run at its next step.
   */
  readonly mode?: "followUp" | "steer";
}

export interface SubmitResult {
  readonly submissionId: string;
  /** True when `requestId` matched an earlier submission. */
  readonly duplicate?: boolean;
  /** The assistant answer, when `wait` was set and the input was answered. */
  readonly message?: Message;
}

export interface ConversationRead {
  readonly id: string;
  readonly entries: readonly EntryRecord[];
}

/**
 * The in-process interaction protocol: one object used by custom routes, plugin
 * `setup`, and the HTTP server. Every surface goes through it.
 */
export class AgentHost {
  readonly engine: Engine;
  private readonly agent: AgentChange;
  private readonly workspace: WorkspaceProvider | undefined;

  constructor(engine: Engine, agent: AgentChange, workspace?: WorkspaceProvider) {
    this.engine = engine;
    this.agent = agent;
    this.workspace = workspace;
  }

  async createConversation(options: CreateConversationOptions = {}): Promise<ConversationInfo> {
    const info = await this.recordConversation(options.key);
    if (this.workspace) await this.ensureWorkspace(info, this.workspace);
    return info;
  }

  /** Prepare and record the workspace of a conversation that has none yet. */
  private async ensureWorkspace(
    info: ConversationInfo,
    provider: WorkspaceProvider,
  ): Promise<void> {
    const records = await this.listConversations();
    if (records.find((c) => c.id === info.id)?.cwd) return;
    const target =
      info.key === undefined
        ? { conversationId: info.id }
        : { conversationId: info.id, key: info.key };
    const { cwd } = await provider.create(target);
    await this.engine.commit(async (tx) => {
      await configure(tx, Number(info.id) as unknown as ConversationId, { cwd });
      const doc = (await tx.doc(ConversationsDoc)) as { conversations: ConversationRecord[] };
      const record = doc.conversations.find((c) => c.id === info.id);
      if (record) record.cwd = cwd;
    });
  }

  private async recordConversation(key: string | undefined): Promise<ConversationInfo> {
    return this.engine.commit(async (tx) => {
      const doc = (await tx.doc(ConversationsDoc)) as { conversations: ConversationRecord[] };
      const existing = key === undefined ? undefined : doc.conversations.find((c) => c.key === key);
      if (existing) return { id: existing.id, key, created: false };
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, record.id, this.agent);
      const id = String(record.id);
      doc.conversations.push(
        key === undefined ? { id, createdAt: Date.now() } : { id, key, createdAt: Date.now() },
      );
      return key === undefined ? { id, created: true } : { id, key, created: true };
    });
  }

  async submitInput(
    id: string,
    content: string,
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const conversation = await this.conversation(id);
    const { requestId } = options;
    if (requestId !== undefined) {
      const earlier = await this.engine.commit((tx) =>
        tx.submissionByRequest(conversation.id, requestId),
      );
      if (earlier) return { submissionId: String(earlier.id), duplicate: true };
    }
    const whenBusy = options.mode ?? "followUp";
    const submission = await conversation.submit(
      requestId === undefined
        ? { type: "input", content, whenBusy }
        : { type: "input", content, whenBusy, requestId },
      CONTEXT,
    );
    const submissionId = String(submission.id);
    if (!options.wait) return { submissionId };
    const settled = await submission.wait(CONTEXT);
    if (settled.status !== "done" || settled.type !== "input") return { submissionId };
    const recent = await conversation.entries({ order: "descending" }, 50, undefined, CONTEXT);
    const answer = recent.items.find((entry) => entry.id === settled.answer);
    return { submissionId, message: answer ? toMessage(answer) : undefined };
  }

  /** Open proposals, across every conversation or for one. */
  async listProposals(options: { conversationId?: string } = {}): Promise<Proposal[]> {
    const open = await listOpenProposals(this.engine);
    return options.conversationId === undefined
      ? open
      : open.filter((p) => p.conversationId === options.conversationId);
  }

  /**
   * Settle an open proposal with the human's decision. With `conversationId`,
   * the proposal must belong to that conversation.
   */
  async submitDecision(
    decision: GateDecision,
    options: { conversationId?: string } = {},
  ): Promise<void> {
    if (options.conversationId !== undefined) await this.conversation(options.conversationId);
    const open = await listOpenProposals(this.engine);
    const proposal = open.find((p) => p.id === decision.proposalId);
    if (
      !proposal ||
      (options.conversationId !== undefined && proposal.conversationId !== options.conversationId)
    ) {
      throw new ProposalNotFound(decision.proposalId);
    }
    await settleGate(this.engine, decision);
  }

  async snapshot(id: string): Promise<ConversationSnapshot> {
    const { entries } = await this.readConversation(id);
    const messages = entries.map(toMessage).filter((m): m is Message => m !== undefined);
    const proposals = await this.listProposals({ conversationId: id });
    const inspection = await this.engine.harness.inspect(CONTEXT);
    const running = inspection.submissions.some(
      (s) => String(s.conversationId) === id && s.status === "placed",
    );
    const transcript = toTranscript(entries, running);
    return { conversationId: id, messages, proposals, running, transcript };
  }

  /** Stop the conversation's current run. Background work such as open gates is untouched. */
  async abort(id: string): Promise<void> {
    const conversation = await this.conversation(id);
    await conversation.abort(CONTEXT);
  }

  async readConversation(id: string): Promise<ConversationRead> {
    const conversation = await this.conversation(id);
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, CONTEXT);
    return { id, entries: page.items };
  }

  /** Every conversation this host created, oldest first. */
  async listConversations(): Promise<ConversationRecord[]> {
    const doc = await this.engine.harness.snapshot(ConversationsDoc, CONTEXT);
    return (doc?.conversations ?? []).map((c) => ({ ...c }));
  }

  /** Whether `id` names a conversation this host created (root never is). */
  async hasConversation(id: string): Promise<boolean> {
    const doc = await this.engine.harness.snapshot(ConversationsDoc, CONTEXT);
    return (doc?.conversations ?? []).some((c) => c.id === id);
  }

  private async conversation(id: string) {
    if (!(await this.hasConversation(id))) throw new ConversationNotFound(id);
    const conversation = await this.engine.harness.conversation(
      Number(id) as unknown as ConversationId,
      CONTEXT,
    );
    if (!conversation) throw new ConversationNotFound(id);
    return conversation;
  }
}

/** The current state of a conversation, sent first on every event stream. */
export interface ConversationSnapshot {
  readonly conversationId: string;
  /** User and assistant messages so far, oldest first. */
  readonly messages: readonly Message[];
  /** Proposals open in this conversation. */
  readonly proposals: readonly Proposal[];
  /** Whether a run is answering input right now. */
  readonly running: boolean;
  /** Messages and tool calls so far, oldest first; running calls included. */
  readonly transcript: readonly TranscriptItem[];
}

export class ConversationNotFound extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`conversation not found: ${conversationId}`);
    this.conversationId = conversationId;
  }
}

export class ProposalNotFound extends Error {
  readonly proposalId: string;

  constructor(proposalId: string) {
    super(`open proposal not found: ${proposalId}`);
    this.proposalId = proposalId;
  }
}

/** The user or assistant message of an entry in the shared `Message` vocabulary. */
export function toMessage(entry: EntryRecord): Message | undefined {
  const model = entry.model?.[0] as
    | { role?: string; content?: unknown; timestamp?: number }
    | undefined;
  if (!model || (model.role !== "assistant" && model.role !== "user")) return undefined;
  if (typeof model.content === "string") {
    return { role: model.role, content: model.content, timestamp: model.timestamp ?? Date.now() };
  }
  const blocks = Array.isArray(model.content) ? model.content : [];
  const content = blocks
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => ({ type: "text" as const, text: b.text }));
  return { role: model.role, content, timestamp: model.timestamp ?? Date.now() };
}

/**
 * The transcript of a conversation's entries: user and assistant text, and each tool
 * call with its outcome. A call without a result is `running` while a run is active,
 * otherwise it was cut off and counts as an error.
 */
export function toTranscript(entries: readonly EntryRecord[], running: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, Extract<TranscriptItem, { type: "tool" }>>();
  for (const entry of entries) {
    const model = entry.model?.[0] as
      | {
          role?: string;
          content?: unknown;
          timestamp?: number;
          toolCallId?: string;
          isError?: boolean;
        }
      | undefined;
    if (!model) continue;
    const timestamp = model.timestamp ?? 0;
    if (model.role === "toolResult" && model.toolCallId) {
      const call = calls.get(model.toolCallId);
      if (call) {
        call.status = model.isError ? "error" : "done";
        call.endedAt = timestamp;
      }
      continue;
    }
    if (model.role !== "user" && model.role !== "assistant") continue;
    const blocks =
      typeof model.content === "string"
        ? [{ type: "text", text: model.content }]
        : Array.isArray(model.content)
          ? (model.content as {
              type?: string;
              text?: string;
              id?: string;
              name?: string;
              arguments?: unknown;
            }[])
          : [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (text) items.push({ type: "message", role: model.role, text, timestamp });
    for (const block of blocks) {
      if (block.type !== "toolCall" || !block.id) continue;
      const call: Extract<TranscriptItem, { type: "tool" }> = {
        type: "tool",
        callId: block.id,
        name: block.name ?? "",
        args: block.arguments ?? {},
        status: running ? "running" : "error",
        startedAt: timestamp,
      };
      calls.set(block.id, call);
      items.push(call);
    }
  }
  return items;
}
