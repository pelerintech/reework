// The agent-wide activity stream's hub. One per agent, fed by the existing
// per-conversation watch streams and the existing in-process listeners; it keeps
// one bounded queue per subscriber and never awaits a socket.
import type { WSContext } from "hono/ws";
import type { WebSocket as NodeWs } from "ws";
import { watchEvents } from "@earendil-works/pi-durable";
import type {
  AgentEvent as DurableEvent,
  ConversationId,
  SubmissionId,
} from "@earendil-works/pi-durable";
import type {
  ActivityEvent,
  ActivityFilter,
  ActivityFrame,
  AgentEvent,
  Case,
  Proposal,
} from "@reework/types";
import type { AgentHost } from "../host.ts";
import { CONTEXT } from "../engine.ts";
import { createEventMapper } from "../protocol/event-mapper.ts";
import {
  activityConversation,
  activityMatches,
  activityOpenWork,
  recordOfCase,
} from "../protocol/activity.ts";
import type { ConversationRecord } from "../protocol/conversations.ts";
import type { SettledProposal } from "../hitl/gate.ts";
import type { ModelUsageEvent } from "../tooling/facade.ts";

/** The deployment bounds of an activity connection's queue. */
export interface ActivityOptions {
  /** A subscriber's queued bytes and socket buffer may not exceed this. */
  readonly maxBufferedBytes?: number;
  /** A subscriber's pending event count may not exceed this. */
  readonly maxPendingEvents?: number;
}

export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
export const DEFAULT_MAX_PENDING_EVENTS = 4096;

interface Subscriber {
  readonly ws: WSContext<NodeWs>;
  readonly raw?: NodeWs;
  readonly filter?: ActivityFilter;
  queue: string[];
  bytes: number;
  snapshotSent: boolean;
  flushing: boolean;
  closed: boolean;
}

interface Watcher {
  readonly id: string;
  readonly stream: Awaited<ReturnType<typeof watchEvents>>;
  readonly map: (event: DurableEvent) => AgentEvent | undefined;
  readonly starts: Map<string, number>;
}

/** One agent's activity subscribers and the watchers feeding them. */
export class ActivityHub {
  private readonly host: AgentHost;
  private readonly maxBufferedBytes: number;
  private readonly maxPendingEvents: number;
  private readonly subscribers = new Map<WSContext<NodeWs>, Subscriber>();
  /** Conversation metadata needed to join events (key, kind, tags, status). */
  private readonly records = new Map<string, ConversationRecord>();
  /** One shared watcher per open-work conversation a subscriber matches. */
  private readonly watchers = new Map<string, Watcher>();
  private readonly attaching = new Map<string, Promise<void>>();
  /** Conversations with a placed input submission (a run in flight). */
  private readonly runActive = new Map<string, boolean>();
  private closed = false;

  constructor(host: AgentHost, options: ActivityOptions = {}) {
    this.host = host;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
  }

  /** Register a connection, send its snapshot first, then flush buffered events. */
  async open(ws: WSContext<NodeWs>, filter?: ActivityFilter): Promise<void> {
    if (this.closed) {
      ws.close(1001, "agent stopping");
      return;
    }
    const subscriber: Subscriber = {
      ws,
      raw: ws.raw,
      filter,
      queue: [],
      bytes: 0,
      snapshotSent: false,
      flushing: false,
      closed: false,
    };
    this.subscribers.set(ws, subscriber);
    await this.refreshRecords();
    await this.refreshWatchers();
    const snapshot = await this.host.activitySnapshot(filter);
    if (subscriber.closed || this.subscribers.get(ws) !== subscriber) return;
    const frame: ActivityFrame = { kind: "snapshot", snapshot, timestamp: Date.now() };
    ws.send(JSON.stringify(frame));
    subscriber.snapshotSent = true;
    this.flush(subscriber);
  }

  /** Drop a closed connection and stop any watcher it no longer needs. */
  closeSubscriber(ws: WSContext<NodeWs>): void {
    const subscriber = this.subscribers.get(ws);
    if (!subscriber) return;
    subscriber.closed = true;
    this.subscribers.delete(ws);
    void this.refreshWatchers();
  }

  /** Stop every subscriber's watcher on agent stop, including attaches in flight. */
  async close(): Promise<void> {
    this.closed = true;
    for (const subscriber of this.subscribers.values()) subscriber.closed = true;
    this.subscribers.clear();
    for (const id of this.watchers.keys()) this.detach(id);
    this.records.clear();
    this.runActive.clear();
    // An attach that was already awaiting watchEvents sees `closed` and stops
    // its stream; waiting here makes that release part of the agent's stop.
    await Promise.allSettled(this.attaching.values());
  }

  /** The watchers the hub currently holds (the testing kit's test-visible seam). */
  watcherCount(): number {
    return this.watchers.size;
  }

  /** A proposal opened: publish its lean question and attach a matching watcher. */
  publishProposalOpened(proposal: Proposal): void {
    const record = this.records.get(proposal.conversationId);
    if (!record) return;
    this.publishEvent({
      kind: "proposal_opened",
      ...activityConversation(record),
      proposalId: proposal.id,
      title: proposal.title,
      audience: proposal.audience,
      options: proposal.options.map((option) => ({ id: option.id, label: option.label })),
      timestamp: Date.now(),
    });
    void this.refreshWatchers();
  }

  /** A proposal settled: publish its lean decision and attach a matching watcher. */
  publishProposalSettled(settled: SettledProposal): void {
    const record = this.records.get(settled.conversationId);
    if (!record) return;
    this.publishEvent({
      kind: "proposal_settled",
      ...activityConversation(record),
      proposalId: settled.proposalId,
      audience: settled.proposal?.audience ?? "human",
      selectedOption: settled.decision.selectedOption,
      ...(settled.decision.decidedBy === undefined
        ? {}
        : { decidedBy: settled.decision.decidedBy }),
      timestamp: Date.now(),
    });
    void this.refreshWatchers();
  }

  /** A conversation-scoped model call's usage; agent-level calls are dropped. */
  publishUsage(event: ModelUsageEvent): void {
    if (event.conversationId === undefined) return;
    const record = this.records.get(event.conversationId);
    if (!record) return;
    this.publishEvent({
      kind: "model_usage",
      ...activityConversation(record),
      source: event.source,
      ...(event.plugin === undefined ? {} : { plugin: event.plugin }),
      model: event.model,
      usage: event.usage,
      timestamp: event.at,
    });
    void this.refreshWatchers();
  }

  /** A case write: update membership, publish the change, and re-evaluate watchers. */
  publishCase(c: Case): void {
    this.records.set(c.id, recordOfCase(c));
    const record = this.records.get(c.id);
    if (!record) return;
    this.publishEvent({
      kind: "case_changed",
      ...activityConversation(record),
      status: c.status,
      ...(c.stage === undefined ? {} : { stage: c.stage }),
      priority: c.priority,
      ...(c.owner === undefined ? {} : { owner: c.owner }),
      needsHuman: c.needsHuman,
      openProposals: c.openProposals,
      timestamp: Date.now(),
    });
    void this.refreshWatchers();
  }

  /** Refresh the conversation records from the host (new conversations included). */
  private async refreshRecords(): Promise<void> {
    for (const record of await this.host.listConversations()) {
      this.records.set(record.id, record);
    }
  }

  /** Attach watchers for matching open work; detach those no subscriber needs. */
  private async refreshWatchers(): Promise<void> {
    const needed = new Set<string>();
    for (const record of this.records.values()) {
      if (!this.anySubscriberMatches(record)) continue;
      if (activityOpenWork(record) || this.runActive.get(record.id) === true) {
        needed.add(record.id);
      }
    }
    for (const id of needed) await this.attach(id);
    for (const id of this.watchers.keys()) {
      if (!needed.has(id)) this.detach(id);
    }
  }

  private anySubscriberMatches(record: ConversationRecord): boolean {
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.closed && activityMatches(record, subscriber.filter)) return true;
    }
    return false;
  }

  /** One watcher per conversation, shared across subscribers. */
  private attach(id: string): Promise<void> {
    if (this.watchers.has(id) || this.closed) return Promise.resolve();
    const existing = this.attaching.get(id);
    if (existing) return existing;
    const attaching = this.doAttach(id).finally(() => this.attaching.delete(id));
    this.attaching.set(id, attaching);
    return attaching;
  }

  private async doAttach(id: string): Promise<void> {
    const stream = await watchEvents(
      this.host.engine.harness,
      Number(id) as unknown as ConversationId,
      CONTEXT,
    );
    if (this.closed || !this.needsWatcher(id)) {
      this.stopStream(stream);
      return;
    }
    const map = createEventMapper(Number(id) as unknown as ConversationId);
    const inspect = await this.host.engine.harness.inspect(CONTEXT);
    // The hub may have closed or lost its last matching subscriber while the
    // attach was awaiting; a watcher must not outlive either.
    if (this.closed || !this.needsWatcher(id)) {
      this.stopStream(stream);
      return;
    }
    const watcher: Watcher = { id, stream, map, starts: new Map() };
    this.watchers.set(id, watcher);
    this.runActive.set(
      id,
      inspect.submissions.some(
        (s) => String(s.conversationId) === id && s.type === "input" && s.status === "placed",
      ),
    );
    stream.start(async (events) => {
      for (const event of events) await this.handleDurable(watcher, event);
    });
  }

  /** Whether an open-work record still has a subscriber that matches it. */
  private needsWatcher(id: string): boolean {
    const record = this.records.get(id);
    if (!record || !this.anySubscriberMatches(record)) return false;
    return activityOpenWork(record) || this.runActive.get(id) === true;
  }

  private stopStream(stream: Watcher["stream"]): void {
    void Promise.resolve(stream.stop()).catch(() => {});
  }

  private detach(id: string): void {
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    this.watchers.delete(id);
    this.runActive.delete(id);
    void Promise.resolve(watcher.stream.stop()).catch(() => {});
  }

  private async handleDurable(watcher: Watcher, event: DurableEvent): Promise<void> {
    const mapped = watcher.map(event);
    if (!mapped) return;
    const record = this.records.get(watcher.id);
    if (!record) return;
    const conversation = activityConversation(record);
    if (mapped.kind === "run_start") {
      this.runActive.set(watcher.id, true);
      this.publishEvent({
        kind: "run_started",
        ...conversation,
        runId: mapped.runId,
        timestamp: mapped.timestamp,
      });
    } else if (mapped.kind === "run_end") {
      this.runActive.set(watcher.id, false);
      const outcome = await this.runOutcome(mapped.runId);
      this.publishEvent({
        kind: "run_ended",
        ...conversation,
        runId: mapped.runId,
        outcome,
        timestamp: mapped.timestamp,
      });
      await this.refreshWatchers();
    } else if (mapped.kind === "tool_execution_start") {
      watcher.starts.set(mapped.callId, mapped.timestamp);
      this.publishEvent({
        kind: "tool_started",
        ...conversation,
        callId: mapped.callId,
        name: mapped.name,
        timestamp: mapped.timestamp,
      });
    } else if (mapped.kind === "tool_execution_end") {
      const startedAt = watcher.starts.get(mapped.callId);
      watcher.starts.delete(mapped.callId);
      this.publishEvent({
        kind: "tool_finished",
        ...conversation,
        callId: mapped.callId,
        name: mapped.name,
        status: mapped.isError ? "error" : "done",
        ...(startedAt === undefined ? {} : { durationMs: mapped.timestamp - startedAt }),
        timestamp: mapped.timestamp,
      });
    }
  }

  private async runOutcome(runId: string): Promise<"completed" | "unanswered"> {
    const submission = await this.host.engine.harness.submission(
      Number(runId) as unknown as SubmissionId,
      CONTEXT,
    );
    const status = await submission?.status(CONTEXT);
    return status?.status === "unanswered" ? "unanswered" : "completed";
  }

  /** Queue an event for every subscriber whose current record matches it. */
  private publishEvent(event: ActivityEvent): void {
    const record = this.records.get(event.conversationId);
    if (!record) return;
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.closed || !activityMatches(record, subscriber.filter)) continue;
      this.enqueue(subscriber, { kind: "event", event });
    }
  }

  /** Queue one serialized frame for a subscriber, enforcing its bounds. */
  protected enqueue(subscriber: Subscriber, frame: ActivityFrame): void {
    const serialized = JSON.stringify(frame);
    subscriber.queue.push(serialized);
    subscriber.bytes += Buffer.byteLength(serialized);
    if (
      subscriber.queue.length > this.maxPendingEvents ||
      subscriber.bytes > this.maxBufferedBytes
    ) {
      this.overflow(subscriber);
      return;
    }
    this.scheduleFlush(subscriber);
  }

  private scheduleFlush(subscriber: Subscriber): void {
    if (subscriber.flushing || !subscriber.snapshotSent || subscriber.closed) return;
    subscriber.flushing = true;
    setImmediate(() => {
      subscriber.flushing = false;
      this.flush(subscriber);
    });
  }

  private flush(subscriber: Subscriber): void {
    if (subscriber.closed || !subscriber.snapshotSent) return;
    while (subscriber.queue.length > 0) {
      if (this.overBuffered(subscriber)) {
        this.overflow(subscriber);
        return;
      }
      const frame = subscriber.queue.shift()!;
      subscriber.bytes -= Buffer.byteLength(frame);
      subscriber.ws.send(frame);
    }
  }

  private overBuffered(subscriber: Subscriber): boolean {
    return (subscriber.raw?.bufferedAmount ?? 0) > this.maxBufferedBytes;
  }

  private overflow(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber.ws);
    subscriber.ws.close(1008, "slow consumer");
    // Dropping the subscriber may have left watchers nobody needs; release them
    // here so an overflow on the flush path does not wait for a later publish.
    void this.refreshWatchers();
  }

  /** Every subscriber, for publishing. */
  protected all(): Subscriber[] {
    return [...this.subscribers.values()];
  }
}
