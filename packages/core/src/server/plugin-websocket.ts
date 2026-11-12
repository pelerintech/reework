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

/** A socket handler's failure is logged with its plugin and never fails the server. */
function logFailure(pluginName: string, error: unknown): void {
  console.error(`[reework] plugin "${pluginName}" socket failed:`, error);
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

/** Adapt a plugin's handlers to Hono's node WebSocket events. */
function adaptEvents(
  pluginName: string,
  events: PluginWebSocketEvents,
  maxMessageBytes: number,
): WSEvents<NodeWs> {
  return {
    onOpen: (_evt, ws) => {
      void events.onOpen?.(socketOf(ws));
    },
    onMessage: (evt, ws) => {
      const data = messageOf(evt.data);
      if (messageBytes(data) > maxMessageBytes) {
        ws.close(1009, "message too big");
        return;
      }
      void events.onMessage?.(data, socketOf(ws));
    },
    onClose: (evt, ws) => {
      void events.onClose?.(evt.code, evt.reason, socketOf(ws));
    },
    onError: (evt, ws) => {
      const error = (evt as unknown as { error?: unknown }).error;
      void events.onError?.(
        error instanceof Error ? error : new Error(String(error)),
        socketOf(ws),
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
  factory: PluginWebSocketFactory,
  limits?: PluginWebSocketLimits,
): (c: Context) => Promise<Response> {
  const maxMessageBytes = limits?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  return async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "websocket_upgrade_required" }, 426);
    }
    const result = await factory(c);
    if (result instanceof Response) return result;
    const events = adaptEvents(pluginName, result, maxMessageBytes);
    return nodeWebSocket.upgradeWebSocket(c, events, {
      onError: (error) => logFailure(pluginName, error),
    });
  };
}
