import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { watchEvents } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { GateDecision, Message } from "@reework/types";
import { settleGate } from "../hitl/gate.ts";
import { listOpenProposals } from "../protocol/proposals.ts";
import { mapDurableEvent } from "../protocol/event-mapper.ts";
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
    return c.json({
      conversationId: id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: result }],
        timestamp: Date.now(),
      } as Message,
      result,
    });
  });

  app.get("/conversations/:id/proposals", async (c) => {
    const proposals = await listOpenProposals(engine);
    return c.json({ id: c.req.param("id"), proposals });
  });

  app.post("/conversations/:id/proposals/:pid/decisions", async (c) => {
    const pid = c.req.param("pid");
    const body = await c.req.json<GateDecision>();
    await settleGate(engine, { ...body, proposalId: pid });
    return c.json({ ok: true });
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
            const mapped = events
              .map((event) => mapDurableEvent(id, event))
              .filter((e) => e !== undefined);
            ws.send(JSON.stringify({ kind: "events", conversationId: id, events: mapped }));
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
