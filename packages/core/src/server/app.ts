import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { watchEvents } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";

/** Route param ids arrive as strings; conversation ids are branded numbers. */
function conversationId(raw: string): ConversationId {
  return Number(raw) as unknown as ConversationId;
}

/**
 * Build the Hono app hosting a conversation over REST + WebSocket. REST
 * exposes message submission and conversation reads; WebSocket streams the
 * agent's live events (`watchEvents`) to clients. Returns the app plus the
 * node WebSocket handle so a host can `injectWebSocket(server)`.
 */
export function createServer(engine: Engine) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const root = await engine.root();
    const entries = await root.entries({ order: "descending" }, 50, undefined, CONTEXT);
    return c.json({ id, entries: entries.items });
  });

  app.post("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ content?: string }>();
    const result = await engine.run(String(body.content ?? ""));
    return c.json({ conversationId: id, result });
  });

  const nodeWebSocket = createNodeWebSocket({ app });
  const { upgradeWebSocket } = nodeWebSocket;

  app.get(
    "/conversations/:id/ws",
    upgradeWebSocket((c) => {
      const id = conversationId(c.req.param("id") ?? "");
      let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
      return {
        onOpen: async (_evt, ws) => {
          stream = await watchEvents(engine.harness, id, CONTEXT);
          ws.send(JSON.stringify({ kind: "snapshot", conversationId: id, events: [] }));
          stream.start(async (events) => {
            ws.send(JSON.stringify({ kind: "events", conversationId: id, events }));
          });
        },
        onClose: () => {
          void stream?.stop();
        },
      };
    }),
  );

  return { app, nodeWebSocket };
}
