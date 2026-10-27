import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { watchEvents } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ROUTES } from "@reework/types";
import type { AgentEvent, CasePatch, GateDecision, RouteId } from "@reework/types";
import { createEventMapper } from "../protocol/event-mapper.ts";
import { onProposalOpen, onProposalSettled } from "../protocol/proposals.ts";
import { CONTEXT } from "../engine.ts";
import { ConversationNotFound, FileNotFound, FileTooLarge, ProposalNotFound } from "../host.ts";
import type { AgentHost } from "../host.ts";

export interface ServerOptions {
  /** Bearer token every route marked `auth: "token"` requires. */
  readonly token: string;
  /** The agent's name, reported by `/health`. */
  readonly name?: string;
}

/** Reject requests whose `Authorization: Bearer` header is not `token`. */
function requireToken(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    const given = Buffer.from(c.req.header("authorization") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

async function decisionFrom(c: Context, proposalId: string): Promise<GateDecision> {
  const body = await c.req.json<Partial<GateDecision>>().catch(() => ({}) as Partial<GateDecision>);
  return {
    proposalId,
    selectedOption: typeof body.selectedOption === "string" ? body.selectedOption : null,
    instruction: typeof body.instruction === "string" ? body.instruction : null,
  };
}

/**
 * Build the Hono app serving the interaction protocol: every route of the shared
 * `ROUTES` table, mounted from it, over the in-process host. Returns the app
 * plus the node WebSocket handle so a host can `injectWebSocket(server)`.
 */
export function createServer(host: AgentHost, options: ServerOptions) {
  const engine = host.engine;
  const app = new Hono();
  const nodeWebSocket = createNodeWebSocket({ app });

  app.onError((error, c) => {
    if (error instanceof ConversationNotFound) {
      return c.json({ error: "conversation_not_found", conversationId: error.conversationId }, 404);
    }
    if (error instanceof ProposalNotFound) {
      return c.json({ error: "proposal_not_found", proposalId: error.proposalId }, 404);
    }
    if (error instanceof FileNotFound) {
      return c.json({ error: "file_not_found", fileId: error.fileId }, 404);
    }
    if (error instanceof FileTooLarge) {
      return c.json({ error: "file_too_large", size: error.size, maxBytes: error.maxBytes }, 413);
    }
    throw error;
  });

  const handlers: Record<RouteId, Handler> = {
    health: (c) =>
      c.json(options.name === undefined ? { ok: true } : { ok: true, name: options.name }),

    "conversations.create": async (c) => {
      const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
      const key = typeof body.key === "string" ? body.key : undefined;
      const conversation = await host.createConversation({ key });
      return c.json(conversation, conversation.created ? 201 : 200);
    },

    "conversations.list": async (c) => {
      const statusParam = c.req.query("status");
      const status = statusParam ? statusParam.split(",").filter(Boolean) : undefined;
      const tagParams = c.req.queries("tag") ?? [];
      const tag = tagParams.length
        ? tagParams.flatMap((t) => t.split(",")).filter(Boolean)
        : undefined;
      const needsParam = c.req.query("needsHuman");
      const needsHuman = needsParam === "true" ? true : needsParam === "false" ? false : undefined;
      const stage = c.req.query("stage") || undefined;
      const sortParam = c.req.query("sort");
      const sort =
        sortParam === "priority" ||
        sortParam === "dueAt" ||
        sortParam === "createdAt" ||
        sortParam === "updatedAt"
          ? sortParam
          : undefined;
      return c.json({
        conversations: await host.listConversations(),
        cases: await host.listCases({ status, tag, needsHuman, stage, sort }),
      });
    },

    "conversations.get": async (c) => c.json(await host.readConversation(c.req.param("id") ?? "")),

    "conversations.getCase": async (c) => c.json(await host.getCase(c.req.param("id") ?? "")),

    "conversations.updateCase": async (c) => {
      const id = c.req.param("id") ?? "";
      const body = await c.req.json().catch(() => ({}));
      try {
        return c.json(await host.updateCase(id, body as CasePatch));
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("invalid case patch:") ||
            error.message.startsWith("cannot close a case"))
        ) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    },

    "conversations.submit": async (c) => {
      const id = c.req.param("id") ?? "";
      const body = await c.req.json<{
        content?: unknown;
        requestId?: unknown;
        mode?: unknown;
        files?: unknown;
      }>();
      const content = typeof body.content === "string" ? body.content : "";
      const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
      const mode = body.mode === "steer" ? "steer" : "followUp";
      const files = Array.isArray(body.files)
        ? body.files.filter((f): f is string => typeof f === "string")
        : undefined;
      const wait = c.req.query("wait") === "true";
      try {
        const { duplicate, ...result } = await host.submitInput(id, content, {
          wait,
          requestId,
          mode,
          files,
        });
        return c.json({ conversationId: id, ...result }, wait || duplicate ? 200 : 202);
      } catch (error) {
        if (error instanceof FileNotFound) {
          return c.json({ error: "file_not_found", fileId: error.fileId }, 400);
        }
        throw error;
      }
    },

    "conversations.abort": async (c) => {
      await host.abort(c.req.param("id") ?? "");
      return c.json({ ok: true });
    },

    "conversations.files": async (c) => {
      const id = c.req.param("id") ?? "";
      if (!(await host.hasConversation(id))) throw new ConversationNotFound(id);
      return c.json({ id, files: await host.listFiles(id) });
    },

    "conversations.uploadFile": async (c) => {
      const id = c.req.param("id") ?? "";
      const name = c.req.query("name");
      if (!name) return c.json({ error: "file name is required" }, 400);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const mimeType = c.req.header("content-type") ?? undefined;
      const record = await host.addFile(id, { name, mimeType, bytes, source: "upload" });
      return c.json(record, 201);
    },

    "conversations.downloadFile": async (c) => {
      const id = c.req.param("id") ?? "";
      const { record, bytes } = await host.readFile(id, c.req.param("fid") ?? "");
      return new Response(bytes, {
        headers: {
          "Content-Type": record.mimeType,
          "Content-Disposition": `attachment; filename="${record.name}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    },

    "conversations.proposals": async (c) => {
      const id = c.req.param("id") ?? "";
      if (!(await host.hasConversation(id))) throw new ConversationNotFound(id);
      return c.json({ id, proposals: await host.listProposals({ conversationId: id }) });
    },

    "conversations.decide": async (c) => {
      const decision = await decisionFrom(c, c.req.param("pid") ?? "");
      await host.submitDecision(decision, { conversationId: c.req.param("id") ?? "" });
      return c.json({ ok: true });
    },

    "conversations.watch": nodeWebSocket.upgradeWebSocket((c) => {
      const raw = c.req.param("id") ?? "";
      const id = Number(raw) as unknown as ConversationId;
      let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
      const unsubscribe: (() => void)[] = [];
      return {
        onOpen: async (_evt, ws) => {
          if (!(await host.hasConversation(raw))) {
            ws.close(4404, "conversation not found");
            return;
          }
          stream = await watchEvents(engine.harness, id, CONTEXT);
          ws.send(JSON.stringify({ kind: "snapshot", events: [], ...(await host.snapshot(raw)) }));
          const map = createEventMapper(id);
          stream.start(async (events) => {
            const mapped = events.map(map).filter((e) => e !== undefined);
            ws.send(JSON.stringify({ kind: "events", conversationId: raw, events: mapped }));
          });
          const send = (event: AgentEvent) =>
            ws.send(JSON.stringify({ kind: "events", conversationId: raw, events: [event] }));
          unsubscribe.push(
            onProposalOpen(engine, (proposal) => {
              if (proposal.conversationId !== raw) return;
              send({
                kind: "proposal_opened",
                conversationId: raw,
                proposal,
                timestamp: Date.now(),
              });
            }),
            onProposalSettled(engine, ({ proposalId, conversationId, decision }) => {
              if (conversationId !== raw) return;
              send({
                kind: "proposal_closed",
                conversationId: raw,
                proposalId,
                selectedOption: decision.selectedOption,
                instruction: decision.instruction,
                timestamp: Date.now(),
              });
            }),
            host.onCaseUpdated((c) => {
              if (c.id !== raw) return;
              send({
                kind: "case_updated",
                conversationId: raw,
                case: c,
                timestamp: Date.now(),
              });
            }),
          );
        },
        onClose: () => {
          for (const off of unsubscribe) off();
          void stream?.stop();
        },
      };
    }),

    "proposals.list": async (c) => c.json({ proposals: await host.listProposals() }),

    // Any open proposal by id, including gates the agent opened on its own root conversation.
    "proposals.decide": async (c) => {
      await host.submitDecision(await decisionFrom(c, c.req.param("pid") ?? ""));
      return c.json({ ok: true });
    },
  };

  const guard = requireToken(options.token);
  for (const [id, route] of Object.entries(ROUTES) as [RouteId, (typeof ROUTES)[RouteId]][]) {
    const handler = handlers[id];
    if (!handler) throw new Error(`route ${id} has no handler`);
    if (route.auth === "token") app.on(route.method, route.path, guard, handler);
    else app.on(route.method, route.path, handler);
  }

  return { app, nodeWebSocket };
}
