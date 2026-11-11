import { randomUUID } from "node:crypto";
import { configure } from "@earendil-works/pi-durable";
import type { AgentChange, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type {
  Author,
  Case,
  CasePatch,
  CasePriority,
  CaseStatus,
  FileRecord,
  Message,
  Proposal,
  TranscriptItem,
} from "@reework/types";
import { isAuthor, normalizeAuthor } from "@reework/types";
import type { Engine } from "./engine.ts";
import { CONTEXT } from "./engine.ts";
import { ConversationsDoc } from "./protocol/conversations.ts";
import { FilesDoc } from "./protocol/files.ts";
import { FileStore } from "./files/store.ts";
import { applyCasePatch, toCase, validateCasePatch } from "./protocol/cases.ts";
import { listOpenProposals } from "./protocol/proposals.ts";
import { settleGate } from "./hitl/gate.ts";
import type { GateDecision } from "@reework/types";
import type { ConversationRecord } from "./protocol/conversations.ts";
import type { WorkspaceProvider } from "./tooling/facade.ts";
import type { EventDispatcher } from "./runtime/events.ts";

/** A conversation as the protocol sees it. Ids are strings on the wire. */
export interface ConversationInfo {
  readonly id: string;
  readonly key?: string;
  /** False when an existing conversation was returned for its key. */
  readonly created: boolean;
}

/** Filters for the case listing. */
export interface ListCasesFilter {
  readonly status?: readonly string[];
  readonly needsHuman?: boolean;
  readonly tag?: readonly string[];
  readonly stage?: string;
  readonly sort?: "priority" | "dueAt" | "createdAt" | "updatedAt";
}

export interface CreateConversationOptions {
  /** Idempotency key: the same key always returns the same conversation. */
  readonly key?: string;
  /** Initial case fields; defaults apply where omitted. */
  readonly case?: { readonly title?: string; readonly priority?: CasePriority };
}

export interface SubmitOptions {
  /** Wait for the run to answer and return the assistant message. */
  readonly wait?: boolean;
  /** Deduplication key: a repeat returns the original submission and admits nothing. */
  readonly requestId?: string;
  /** File ids of this conversation to name in the input. */
  readonly files?: readonly string[];
  /** Who the input is from; absent means unattributed (never assumed human). */
  readonly from?: Author;
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
  private readonly fileStore: FileStore;
  private readonly filesMaxBytes: number;
  /** The agent's event-hook dispatcher; events reach plugins after their commit. */
  private readonly events: EventDispatcher | undefined;
  /** In-process listeners for case writes, for surfaces watching the conversation. */
  private readonly caseListeners = new Set<(c: Case) => void>();

  constructor(
    engine: Engine,
    agent: AgentChange,
    workspace?: WorkspaceProvider,
    files: { maxBytes?: number } = {},
    events?: EventDispatcher,
  ) {
    this.engine = engine;
    this.agent = agent;
    this.workspace = workspace;
    this.fileStore = new FileStore(engine.path);
    this.filesMaxBytes = files.maxBytes ?? 10 * 1024 * 1024;
    this.events = events;
  }

  async createConversation(options: CreateConversationOptions = {}): Promise<ConversationInfo> {
    const info = await this.recordConversation(options.key, options.case);
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

  private async recordConversation(
    key: string | undefined,
    initialCase?: CreateConversationOptions["case"],
  ): Promise<ConversationInfo> {
    return this.engine.commit(async (tx) => {
      const doc = (await tx.doc(ConversationsDoc)) as { conversations: ConversationRecord[] };
      const existing = key === undefined ? undefined : doc.conversations.find((c) => c.key === key);
      if (existing) return { id: existing.id, key, created: false };
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, record.id, this.agent);
      const id = String(record.id);
      const now = Date.now();
      doc.conversations.push({
        id,
        ...(key === undefined ? {} : { key }),
        createdAt: now,
        status: "open",
        priority: initialCase?.priority ?? "normal",
        tags: [],
        ...(initialCase?.title === undefined ? {} : { title: initialCase.title }),
        caseUpdatedAt: now,
      });
      return key === undefined ? { id, created: true } : { id, key, created: true };
    });
  }

  /** Subscribe (in-process) to case writes. Returns an unsubscribe fn. */
  onCaseUpdated(listener: (c: Case) => void): () => void {
    this.caseListeners.add(listener);
    return () => this.caseListeners.delete(listener);
  }

  private notifyCaseUpdated(c: Case): void {
    for (const listener of this.caseListeners) listener(c);
  }

  /** The conversation's case, with derived fields from open proposals. */
  async getCase(id: string): Promise<Case> {
    const record = await this.conversationRecord(id);
    const openProposals = (await this.listProposals({ conversationId: id })).length;
    return toCase(record, openProposals);
  }

  /** Every conversation's case, newest first, optionally filtered.
   *  `status`/`needsHuman`/`tag`/`stage` filter; `sort` orders (`priority`, `dueAt`, `createdAt`,
   *  `updatedAt`, default newest). */
  async listCases(filter: ListCasesFilter = {}): Promise<Case[]> {
    const doc = await this.engine.harness.snapshot(ConversationsDoc, CONTEXT);
    const open = await listOpenProposals(this.engine);
    const byConversation = new Map<string, number>();
    for (const p of open) {
      byConversation.set(p.conversationId, (byConversation.get(p.conversationId) ?? 0) + 1);
    }
    let cases = (doc?.conversations ?? []).map((c) => toCase(c, byConversation.get(c.id) ?? 0));
    if (filter.status && filter.status.length) {
      const statuses = new Set(filter.status);
      cases = cases.filter((c) => statuses.has(c.status));
    }
    if (filter.needsHuman !== undefined) {
      cases = cases.filter((c) => c.needsHuman === filter.needsHuman);
    }
    if (filter.tag && filter.tag.length) {
      cases = cases.filter((c) => filter.tag!.every((t) => c.tags.includes(t)));
    }
    if (filter.stage) cases = cases.filter((c) => c.stage === filter.stage);
    const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    return cases.slice().sort((a, b) => {
      if (filter.sort === "priority") {
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.updatedAt - a.updatedAt;
      }
      if (filter.sort === "dueAt") {
        const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
        return aDue - bDue || b.updatedAt - a.updatedAt;
      }
      if (filter.sort === "createdAt") {
        return b.createdAt - a.createdAt || Number(b.id) - Number(a.id);
      }
      return b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id);
    });
  }

  /** Enqueue the case-lifecycle hook a status change calls for; a no-op change fires nothing. */
  private caseTransition(
    id: string,
    before: CaseStatus,
    after: Case,
    cause: "input" | "update",
  ): void {
    if (before === after.status) return;
    if (after.status === "closed") {
      this.events?.enqueue("onCaseClosed", id, { case: after });
    } else if (before === "closed") {
      this.events?.enqueue("onCaseReopened", id, { case: after, cause });
    }
  }

  /** Update a conversation's case. An invalid patch is refused naming the field. */
  async updateCase(id: string, patch: CasePatch): Promise<Case> {
    const result = validateCasePatch(patch);
    if (!result.ok) {
      const [first] = result.errors;
      throw new Error(`invalid case patch: field "${first!.field}" ${first!.reason}`);
    }
    if (patch.status === "closed") {
      const open = await this.listProposals({ conversationId: id });
      if (open.length > 0) {
        throw new Error(
          `cannot close a case with ${open.length} open proposal(s) (${open.map((p) => p.id).join(", ")})`,
        );
      }
    }
    const before = (await this.conversationRecord(id)).status ?? "open";
    await this.engine.commit(async (tx) => {
      const doc = (await tx.doc(ConversationsDoc)) as { conversations: ConversationRecord[] };
      const rec = doc.conversations.find((c) => c.id === id);
      if (!rec) throw new ConversationNotFound(id);
      applyCasePatch(rec, patch);
    });
    const record = await this.conversationRecord(id);
    const openProposals = (await this.listProposals({ conversationId: id })).length;
    const updated = toCase(record, openProposals);
    this.notifyCaseUpdated(updated);
    this.caseTransition(id, before, updated, "update");
    return updated;
  }

  private async conversationRecord(id: string): Promise<ConversationRecord> {
    const doc = await this.engine.harness.snapshot(ConversationsDoc, CONTEXT);
    const rec = (doc?.conversations ?? []).find((c) => c.id === id);
    if (!rec) throw new ConversationNotFound(id);
    return rec;
  }

  /** Store a file for a conversation; refuses files over `files.maxBytes`. */
  async addFile(
    conversationId: string,
    input: { name: string; mimeType?: string; bytes: Uint8Array; source?: "upload" | "plugin" },
  ): Promise<FileRecord> {
    await this.conversationRecord(conversationId);
    const name = sanitizeFileName(input.name);
    if (!name) throw new Error("file name is required");
    if (input.bytes.length > this.filesMaxBytes) {
      throw new FileTooLarge(input.bytes.length, this.filesMaxBytes);
    }
    const mimeType = input.mimeType || "application/octet-stream";
    const sha256 = this.fileStore.write(input.bytes);
    const record: FileRecord = {
      id: randomUUID(),
      conversationId,
      name,
      mimeType,
      size: input.bytes.length,
      sha256,
      createdAt: Date.now(),
      source: input.source ?? "upload",
    };
    await this.engine.commit(async (tx) => {
      const doc = (await tx.doc(FilesDoc)) as { files: FileRecord[] };
      doc.files.push(record);
    });
    return record;
  }

  /** Every file of a conversation, oldest first. */
  async listFiles(conversationId: string): Promise<FileRecord[]> {
    const doc = await this.engine.harness.snapshot(FilesDoc, CONTEXT);
    return (doc?.files ?? []).filter((f) => f.conversationId === conversationId);
  }

  /** A file's record and bytes; refuses a file of another conversation. */
  async readFile(
    conversationId: string,
    fileId: string,
  ): Promise<{ record: FileRecord; bytes: Uint8Array }> {
    const doc = await this.engine.harness.snapshot(FilesDoc, CONTEXT);
    const record = (doc?.files ?? []).find(
      (f) => f.id === fileId && f.conversationId === conversationId,
    );
    if (!record) throw new FileNotFound(fileId);
    return { record, bytes: this.fileStore.read(record.sha256) };
  }

  async submitInput(
    id: string,
    content: string,
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const from = options.from === undefined ? undefined : requireAuthor(options.from);
    if (options.files?.length) {
      const lines: string[] = [];
      for (const fid of options.files) {
        // Throws FileNotFound when the file is not in this conversation.
        const { record } = await this.readFile(id, fid);
        lines.push(
          `Attached: ${record.name} (${record.mimeType}, ${record.size} bytes, file ${record.id})`,
        );
      }
      content = `${content}\n\n${lines.join("\n")}`;
    }
    const conversation = await this.conversation(id);
    const before = (await this.conversationRecord(id)).status ?? "open";
    // Submitting input reopens a closed case (and clears `closedAt`) and always
    // moves `updatedAt`; a waiting case stays waiting. (The gate's resume is
    // separate and never reopens.)
    await this.engine.commit(async (tx) => {
      const doc = (await tx.doc(ConversationsDoc)) as { conversations: ConversationRecord[] };
      const rec = doc.conversations.find((c) => c.id === id);
      if (rec) {
        if (rec.status === "closed") {
          rec.status = "open";
          delete rec.closedAt;
        }
        rec.caseUpdatedAt = Math.max(Date.now(), (rec.caseUpdatedAt ?? rec.createdAt) + 1);
      }
    });
    const reopened = await this.getCase(id);
    this.notifyCaseUpdated(reopened);
    this.caseTransition(id, before, reopened, "input");
    const { requestId } = options;
    if (requestId !== undefined) {
      const earlier = await this.engine.commit((tx) =>
        tx.submissionByRequest(conversation.id, requestId),
      );
      if (earlier) return { submissionId: String(earlier.id), duplicate: true };
    }
    const whenBusy = options.mode ?? "followUp";
    const submission = await conversation.submit(
      {
        type: "input",
        content,
        whenBusy,
        ...(requestId === undefined ? {} : { requestId }),
        ...(from === undefined
          ? {}
          : {
              entry: {
                kind: "reework.input",
                data: { from } as unknown as JsonValue,
              },
            }),
      },
      CONTEXT,
    );
    const submissionId = String(submission.id);
    this.events?.enqueue("onInput", id, {
      conversationId: id,
      submissionId,
      content,
      ...(from === undefined ? {} : { from }),
    });
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
    const decidedBy =
      decision.decidedBy === undefined ? undefined : requireAuthor(decision.decidedBy);
    const open = await listOpenProposals(this.engine);
    const proposal = open.find((p) => p.id === decision.proposalId);
    if (
      !proposal ||
      (options.conversationId !== undefined && proposal.conversationId !== options.conversationId)
    ) {
      throw new ProposalNotFound(decision.proposalId);
    }
    await settleGate(this.engine, {
      proposalId: decision.proposalId,
      selectedOption: decision.selectedOption,
      instruction: decision.instruction,
      ...(decidedBy === undefined ? {} : { decidedBy }),
    });
  }

  async snapshot(id: string): Promise<ConversationSnapshot> {
    const { entries } = await this.readConversation(id);
    const messages = entries.map(toMessage).filter((m): m is Message => m !== undefined);
    const proposals = await this.listProposals({ conversationId: id });
    const inspect = await this.engine.harness.inspect(CONTEXT);
    const running = inspect.submissions.some(
      (s) => String(s.conversationId) === id && s.status === "placed",
    );
    const transcript = toTranscript(entries, running);
    const caseInfo = await this.getCase(id);
    return { conversationId: id, messages, proposals, running, transcript, case: caseInfo };
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
  /** The conversation's case at snapshot time. */
  readonly case: Case;
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

export class FileNotFound extends Error {
  readonly fileId: string;

  constructor(fileId: string) {
    super(`file not found: ${fileId}`);
    this.fileId = fileId;
  }
}

export class FileTooLarge extends Error {
  readonly size: number;
  readonly maxBytes: number;

  constructor(size: number, maxBytes: number) {
    super(`file too large: ${size} bytes (limit ${maxBytes})`);
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** A well-formed author, with only its known fields. */
function requireAuthor(value: unknown): Author {
  if (!isAuthor(value)) throw new InvalidAuthor();
  return normalizeAuthor(value);
}

/** An input or decision carried an author that is not well-formed. */
export class InvalidAuthor extends Error {
  constructor() {
    super("invalid author");
  }
}

/** Keep only the final path segment of a name; strip separators. */
function sanitizeFileName(name: string): string {
  const parts = name.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

/** The user or assistant message of an entry in the shared `Message` vocabulary. */
export function toMessage(entry: EntryRecord): Message | undefined {
  const model = entry.model?.[0] as
    | { role?: string; content?: unknown; timestamp?: number }
    | undefined;
  if (!model || (model.role !== "assistant" && model.role !== "user")) return undefined;
  const from = authorOf(entry);
  const timestamp = model.timestamp ?? Date.now();
  if (typeof model.content === "string") {
    return { role: model.role, content: model.content, timestamp, ...(from ? { from } : {}) };
  }
  const blocks = Array.isArray(model.content) ? model.content : [];
  const content = blocks
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => ({ type: "text" as const, text: b.text }));
  return { role: model.role, content, timestamp, ...(from ? { from } : {}) };
}

/** The author an entry records, when it carries a well-formed one. */
function authorOf(entry: EntryRecord): Author | undefined {
  const data = entry.data as { from?: unknown } | undefined;
  return isAuthor(data?.from) ? data.from : undefined;
}

/** Whether a stored result's details carry the framework's external flag. */
function externalOfDetails(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  const reework = (details as { reework?: unknown }).reework;
  if (typeof reework !== "object" || reework === null) return false;
  return (reework as { external?: unknown }).external === true;
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
          details?: unknown;
        }
      | undefined;
    if (!model) continue;
    const timestamp = model.timestamp ?? 0;
    if (model.role === "toolResult" && model.toolCallId) {
      const call = calls.get(model.toolCallId);
      if (call) {
        call.status = model.isError ? "error" : "done";
        call.endedAt = timestamp;
        if (externalOfDetails(model.details)) call.external = true;
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
    const from = authorOf(entry);
    if (text)
      items.push({
        type: "message",
        role: model.role,
        text,
        timestamp,
        ...(from ? { from } : {}),
      });
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
