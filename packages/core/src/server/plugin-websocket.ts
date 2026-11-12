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

/** An upgrade that reserved a slot and has not opened (or failed) yet. */
interface Reservation {
  plugin: string;
  request: IncomingMessage;
  rawSocket: Socket;
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
  reserve(pluginName: string, maxSockets: number, request: IncomingMessage): boolean;
  /** Release a reservation whose upgrade was refused or failed. */
  release(request: IncomingMessage): void;
  add(pluginName: string, socket: NodeWs): void;
  count(pluginName: string): number;
  entries(): { plugin: string; socket: NodeWs }[];
  /** Close every open socket with a reason and resolve once they all closed. */
  closeAll(code: number, reason: string): Promise<void>;
  /** Force the remaining sockets closed, without a handshake. */
  terminateAll(): void;
  /** The plugins still holding an open socket or a pending upgrade. */
  pending(): string[];
}

export function createPluginSocketRegistry(): PluginSocketRegistry {
  const byPlugin = new Map<string, Set<NodeWs>>();
  const reservations = new WeakMap<IncomingMessage, Reservation>();
  const pendingByPlugin = new Map<string, Set<Reservation>>();
  const entries = () =>
    [...byPlugin].flatMap(([plugin, sockets]) =>
      [...sockets].map((socket) => ({ plugin, socket })),
    );

  const settle = (reservation: Reservation) => {
    if (reservation.settled) return;
    reservation.settled = true;
    const pending = pendingByPlugin.get(reservation.plugin);
    pending?.delete(reservation);
    if (pending?.size === 0) pendingByPlugin.delete(reservation.plugin);
    reservations.delete(reservation.request);
    reservation.rawSocket.off("close", reservation.onAbort);
  };

  const settleOne = (pluginName: string) => {
    const pending = pendingByPlugin.get(pluginName);
    const first = pending?.values().next().value;
    if (first) settle(first);
  };

  return {
    reserve(pluginName, maxSockets, request) {
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
    add(pluginName, socket) {
      const sockets = byPlugin.get(pluginName) ?? new Set<NodeWs>();
      byPlugin.set(pluginName, sockets);
      sockets.add(socket);
      settleOne(pluginName);
      socket.once("close", () => {
        sockets.delete(socket);
        if (sockets.size === 0) byPlugin.delete(pluginName);
      });
    },
    count(pluginName) {
      return (byPlugin.get(pluginName)?.size ?? 0) + (pendingByPlugin.get(pluginName)?.size ?? 0);
    },
    entries,
    closeAll(code, reason) {
      const waits = entries().map(
        ({ socket }) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === 3) return resolve();
            socket.once("close", () => resolve());
            socket.close(code, reason);
          }),
      );
      return Promise.all(waits).then(() => {});
    },
    terminateAll() {
      for (const { socket } of entries()) socket.terminate();
    },
    pending() {
      return [...new Set([...entries().map(({ plugin }) => plugin), ...pendingByPlugin.keys()])];
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

function messageBytes(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
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
  maxMessageBytes: number,
): WSEvents<NodeWs> {
  return {
    onOpen: (_evt, ws) => {
      if (ws.raw) registry.add(pluginName, ws.raw);
      safe(pluginName, () => events.onOpen?.(socketOf(ws)));
    },
    onMessage: (evt, ws) => {
      const data = messageOf(evt.data);
      if (messageBytes(data) > maxMessageBytes) {
        ws.close(1009, "message too big");
        return;
      }
      safe(pluginName, () => events.onMessage?.(data, socketOf(ws)));
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
  const maxMessageBytes = limits?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxSockets = Math.min(limits?.maxSockets ?? DEFAULT_MAX_SOCKETS, PLUGIN_SOCKET_CEILING);
  return async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "websocket_upgrade_required" }, 426);
    }
    const request = incomingOf(c);
    if (!request) return c.json({ error: "websocket_upgrade_required" }, 426);
    if (!registry.reserve(pluginName, maxSockets, request)) {
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
    const events = adaptEvents(pluginName, registry, result, maxMessageBytes);
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
