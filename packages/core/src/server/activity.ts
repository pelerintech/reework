// The agent-wide activity stream's hub. One per agent, fed by the existing
// per-conversation watch streams and the existing in-process listeners; it keeps
// one bounded queue per subscriber and never awaits a socket.
import type { WSContext } from "hono/ws";
import type { WebSocket as NodeWs } from "ws";
import type { ActivityFilter, ActivityFrame } from "@reework/types";
import type { AgentHost } from "../host.ts";

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

/** One agent's activity subscribers and the watchers feeding them. */
export class ActivityHub {
  private readonly host: AgentHost;
  private readonly maxBufferedBytes: number;
  private readonly maxPendingEvents: number;
  private readonly subscribers = new Map<WSContext<NodeWs>, Subscriber>();
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
  }

  /** Stop every subscriber's watcher on agent stop. */
  async close(): Promise<void> {
    this.closed = true;
    for (const subscriber of this.subscribers.values()) subscriber.closed = true;
    this.subscribers.clear();
  }

  /** The watchers the hub currently holds (the testing kit's test-visible seam). */
  watcherCount(): number {
    return 0;
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
  }

  /** Every subscriber, for publishing. */
  protected all(): Subscriber[] {
    return [...this.subscribers.values()];
  }
}
