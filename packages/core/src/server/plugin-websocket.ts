import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { NodeWebSocket } from "@hono/node-ws";
import type { Context } from "hono";
import type { WSEvents, WSContext, WSMessageReceive } from "hono/ws";
import type { WebSocket as NodeWs } from "ws";
import type {
  PluginWebSocket,
  PluginWebSocketEvents,
  PluginWebSocketFactory,
  PluginWebSocketLimits,
} from "../tooling/facade.ts";

/** Largest incoming message a plugin socket accepts when it names no limit. */
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;
/** Most sockets one plugin may hold when an upgrade call names no cap. */
const DEFAULT_MAX_SOCKETS = 8;
/** The ceiling a plugin may never exceed, however its routes name their caps. */
const PLUGIN_SOCKET_CEILING = 64;

/** A limit is a positive integer; anything else is a plugin bug, not a clamp. */
function positiveLimit(
  pluginName: string,
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `plugin "${pluginName}" WebSocket limit ${name} must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

/** An upgrade that reserved a slot and has not opened (or failed) yet. */
interface Reservation {
  plugin: string;
  request: IncomingMessage;
  rawSocket: Socket;
  maxMessageBytes: number;
  onAbort: () => void;
  settled: boolean;
}

/** The plugin sockets of one agent, keyed by plugin name. */
export interface PluginSocketRegistry {
  /**
   * Reserve one of a plugin's slots before the factory is awaited. A pending
   * upgrade counts like an open socket, so concurrent handshakes cannot bypass
   * the cap. False means the plugin is at its cap.
   */
  reserve(
    pluginName: string,
    maxSockets: number,
    request: IncomingMessage,
    maxMessageBytes: number,
  ): boolean;
  /** Release a reservation whose upgrade was refused or failed. */
  release(request: IncomingMessage): void;
  /** The message limit `ws` should enforce while receiving this upgrade. */
  maxPayloadFor(request: IncomingMessage): number | undefined;
  /** Record an upgraded socket, plugin or protocol, once `ws` opened it. */
  adopt(request: IncomingMessage, socket: NodeWs): void;
  add(pluginName: string, socket: NodeWs): void;
  count(pluginName: string): number;
  entries(): { plugin: string; socket: NodeWs }[];
  /** Close every upgraded socket with a reason and resolve once they all closed. */
  closeAll(code: number, reason: string): Promise<void>;
  /** Force the remaining sockets closed, without a handshake. */
  terminateAll(): void;
  /** The plugins still holding an open socket or a pending upgrade. */
  pending(): string[];
  /** Whether any upgraded socket, or an upgrade in flight, is still around. */
  hasUpgraded(): boolean;
  /** True from the first close on stop; later upgrades are refused or closed. */
  isStopping(): boolean;
}

/** Give ws's own oversize abort the reason the contract requires. */
function patchOversizeClose(socket: NodeWs): void {
  const close = socket.close.bind(socket);
  socket.close = (code?: number, data?: string | Buffer) => {
    const reason = code === 1009 && (data === undefined || data === "") ? "message too big" : data;
    close(code, reason);
  };
}

export function createPluginSocketRegistry(): PluginSocketRegistry {
  const byPlugin = new Map<string, Set<NodeWs>>();
  const reservations = new WeakMap<IncomingMessage, Reservation>();
  const pendingByPlugin = new Map<string, Set<Reservation>>();
  const upgraded = new Set<NodeWs>();
  let stopping = false;
  let idleWaiters: (() => void)[] = [];
  const entries = () =>
    [...byPlugin].flatMap(([plugin, sockets]) =>
      [...sockets].map((socket) => ({ plugin, socket })),
    );
  const pendingReservations = () => [...pendingByPlugin.values()].flatMap((set) => [...set]);
  const isIdle = () => upgraded.size === 0 && pendingReservations().length === 0;
  const notify = () => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const whenIdle = () =>
    isIdle()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
        });

  const settle = (reservation: Reservation) => {
    if (reservation.settled) return;
    reservation.settled = true;
    const pending = pendingByPlugin.get(reservation.plugin);
    pending?.delete(reservation);
    if (pending?.size === 0) pendingByPlugin.delete(reservation.plugin);
    reservations.delete(reservation.request);
    reservation.rawSocket.off("close", reservation.onAbort);
    notify();
  };

  const settleOne = (pluginName: string) => {
    const pending = pendingByPlugin.get(pluginName);
    const first = pending?.values().next().value;
    if (first) settle(first);
  };

  const track = (socket: NodeWs) => {
    if (socket.readyState === 3 || upgraded.has(socket)) return;
    upgraded.add(socket);
    socket.once("close", () => {
      upgraded.delete(socket);
      notify();
    });
  };

  const addSocket = (pluginName: string, socket: NodeWs) => {
    const sockets = byPlugin.get(pluginName) ?? new Set<NodeWs>();
    byPlugin.set(pluginName, sockets);
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        if (sockets.size === 0) byPlugin.delete(pluginName);
      });
    }
    track(socket);
  };

  const closeSocket = (socket: NodeWs, code: number, reason: string) => {
    if (socket.readyState === 3) return;
    socket.close(code, reason);
  };

  return {
    reserve(pluginName, maxSockets, request, maxMessageBytes) {
      if (
        (byPlugin.get(pluginName)?.size ?? 0) + (pendingByPlugin.get(pluginName)?.size ?? 0) >=
        maxSockets
      ) {
        return false;
      }
      const rawSocket = request.socket;
      const reservation = {
        plugin: pluginName,
        request,
        rawSocket,
        maxMessageBytes,
        onAbort: () => settle(reservation),
        settled: false,
      };
      reservations.set(request, reservation);
      const pending = pendingByPlugin.get(pluginName) ?? new Set<Reservation>();
      pendingByPlugin.set(pluginName, pending);
      pending.add(reservation);
      rawSocket.once("close", reservation.onAbort);
      return true;
    },
    release(request) {
      const reservation = reservations.get(request);
      if (reservation) settle(reservation);
    },
    maxPayloadFor(request) {
      return reservations.get(request)?.maxMessageBytes;
    },
    adopt(request, socket) {
      const reservation = reservations.get(request);
      if (reservation) {
        settle(reservation);
        addSocket(reservation.plugin, socket);
        patchOversizeClose(socket);
      } else {
        track(socket);
      }
      if (stopping && socket.readyState !== 3) socket.terminate();
    },
    add(pluginName, socket) {
      addSocket(pluginName, socket);
      settleOne(pluginName);
    },
    count(pluginName) {
      return (byPlugin.get(pluginName)?.size ?? 0) + (pendingByPlugin.get(pluginName)?.size ?? 0);
    },
    entries,
    closeAll(code, reason) {
      stopping = true;
      for (const socket of upgraded) closeSocket(socket, code, reason);
      return whenIdle();
    },
    terminateAll() {
      stopping = true;
      for (const socket of upgraded) socket.terminate();
      for (const reservation of pendingReservations()) {
        reservation.rawSocket.destroy();
        settle(reservation);
      }
    },
    pending() {
      return [...new Set([...entries().map(({ plugin }) => plugin), ...pendingByPlugin.keys()])];
    },
    hasUpgraded() {
      return upgraded.size > 0 || pendingReservations().length > 0;
    },
    isStopping() {
      return stopping;
    },
  };
}

/** A socket handler's failure is logged with its plugin and never fails the server. */
function logFailure(pluginName: string, error: unknown): void {
  console.error(`[reework] plugin "${pluginName}" socket failed:`, error);
}

/** Run one handler, logging a synchronous throw or an async rejection. */
function safe(pluginName: string, call: () => unknown): void {
  try {
    const result = call();
    if (result instanceof Promise) {
      void result.catch((error) => logFailure(pluginName, error));
    }
  } catch (error) {
    logFailure(pluginName, error);
  }
}

/** The reework shape of one socket: send, close and the ready state, no raw `ws`. */
function socketOf(ws: WSContext<NodeWs>): PluginWebSocket {
  return {
    send: (data) => ws.send(typeof data === "string" ? data : new Uint8Array(data)),
    close: (code, reason) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
  };
}

/** Incoming text stays text; binary arrives as bytes. */
function messageOf(raw: WSMessageReceive): string | Uint8Array {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw as ArrayBufferLike);
}

/** The raw request the node WebSocket helper upgrades, when this is a real upgrade. */
function incomingOf(c: Context): IncomingMessage | undefined {
  return (c.env as { incoming?: IncomingMessage }).incoming;
}

/** Adapt a plugin's handlers to Hono's node WebSocket events. */
function adaptEvents(
  pluginName: string,
  registry: PluginSocketRegistry,
  events: PluginWebSocketEvents,
): WSEvents<NodeWs> {
  return {
    onOpen: (_evt, ws) => {
      if (ws.raw) registry.add(pluginName, ws.raw);
      safe(pluginName, () => events.onOpen?.(socketOf(ws)));
    },
    onMessage: (evt, ws) => {
      safe(pluginName, () => events.onMessage?.(messageOf(evt.data), socketOf(ws)));
    },
    onClose: (evt, ws) => {
      safe(pluginName, () => events.onClose?.(evt.code, evt.reason, socketOf(ws)));
    },
    onError: (evt, ws) => {
      const error = (evt as unknown as { error?: unknown }).error;
      safe(pluginName, () =>
        events.onError?.(error instanceof Error ? error : new Error(String(error)), socketOf(ws)),
      );
    },
  };
}

/**
 * Pass each plugin upgrade's message limit to `ws` as its `maxPayload`, so an
 * oversized frame is refused while it is received, not after it is buffered.
 */
export function installPluginSocketOptions(
  nodeWebSocket: NodeWebSocket,
  registry: PluginSocketRegistry,
): void {
  const wss = nodeWebSocket.wss;
  const handleUpgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (request, socket, head, callback) => {
    const maxPayload = registry.maxPayloadFor(request);
    const previous = wss.options.maxPayload;
    if (maxPayload !== undefined) wss.options.maxPayload = maxPayload;
    try {
      handleUpgrade(request, socket, head, callback);
    } finally {
      wss.options.maxPayload = previous;
    }
  };
}

/**
 * Build a plugin route's upgrade handler: it refuses a non-upgrade request, lets
 * the factory refuse with a `Response`, and otherwise upgrades through the node
 * WebSocket instance the agent's server already injects.
 */
export function pluginUpgradeWebSocket(
  nodeWebSocket: NodeWebSocket,
  pluginName: string,
  registry: PluginSocketRegistry,
  factory: PluginWebSocketFactory,
  limits?: PluginWebSocketLimits,
): (c: Context) => Promise<Response> {
  const maxMessageBytes = positiveLimit(
    pluginName,
    "maxMessageBytes",
    limits?.maxMessageBytes,
    DEFAULT_MAX_MESSAGE_BYTES,
  );
  const maxSockets = Math.min(
    positiveLimit(pluginName, "maxSockets", limits?.maxSockets, DEFAULT_MAX_SOCKETS),
    PLUGIN_SOCKET_CEILING,
  );
  return async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "websocket_upgrade_required" }, 426);
    }
    const request = incomingOf(c);
    if (!request) return c.json({ error: "websocket_upgrade_required" }, 426);
    if (!registry.reserve(pluginName, maxSockets, request, maxMessageBytes)) {
      return c.json({ error: "too_many_sockets" }, 429);
    }
    let result: PluginWebSocketEvents | Response;
    try {
      result = await factory(c);
    } catch (error) {
      registry.release(request);
      throw error;
    }
    if (result instanceof Response) {
      registry.release(request);
      return result;
    }
    // An upgrade whose factory resolved after stop began must not open.
    if (registry.isStopping()) {
      registry.release(request);
      return c.json({ error: "agent_stopping" }, 503);
    }
    const events = adaptEvents(pluginName, registry, result);
    try {
      return nodeWebSocket.upgradeWebSocket(c, events, {
        onError: (error) => logFailure(pluginName, error),
      });
    } catch (error) {
      registry.release(request);
      throw error;
    }
  };
}
