// @reework/client — the protocol client the TUI, agent projects, and external
// systems use. Every call is built from the shared `ROUTES` table.
import WebSocket from "ws";
import { ROUTES } from "@reework/types";
import type {
  AgentEvent,
  ConversationCreated,
  GateDecision,
  Message,
  Proposal,
  RouteId,
  SnapshotEvent,
  SubmissionAccepted,
  SubmissionAnswered,
} from "@reework/types";

export interface ClientOptions {
  /** Base URL of the agent server, e.g. `http://127.0.0.1:8080`. */
  readonly baseUrl: string;
  /** The agent's API token (`REEWORK_API_TOKEN`). */
  readonly token: string;
}

export interface ConversationListing {
  readonly id: string;
  readonly key?: string;
  readonly createdAt: number;
}

export interface ConversationEntries {
  readonly id: string;
  readonly entries: readonly unknown[];
}

export interface SubmitOptions {
  /** Hold the request until the agent answers. */
  readonly wait?: boolean;
  /** Deduplication key: a repeat returns the original submission. */
  readonly requestId?: string;
  /** `steer` takes the input into an active run; `followUp` (default) queues it. */
  readonly mode?: "followUp" | "steer";
}

/** A frame of `watch`: the snapshot first, then batches of live events. */
export type WatchFrame =
  | (SnapshotEvent & { messages: Message[]; proposals: Proposal[]; running: boolean })
  | { kind: "events"; conversationId: string; events: AgentEvent[] };

export class ProtocolError extends Error {
  readonly status: number;
  readonly route: RouteId;

  constructor(route: RouteId, status: number, body: string) {
    super(`${route} failed with ${status}: ${body}`);
    this.route = route;
    this.status = status;
  }
}

interface CallOptions {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

export function createClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const auth = { authorization: `Bearer ${options.token}` };

  const pathOf = (id: RouteId, params: Record<string, string> = {}) =>
    ROUTES[id].path.replace(/:(\w+)/g, (_match, name: string) => {
      const value = params[name];
      if (value === undefined) throw new Error(`${id}: missing path parameter ${name}`);
      return encodeURIComponent(value);
    });

  /** Call a route of the table by id. */
  async function call<T>(
    id: RouteId,
    call: CallOptions = {},
  ): Promise<{ status: number; body: T }> {
    const route = ROUTES[id];
    const query = call.query ? `?${new URLSearchParams(call.query).toString()}` : "";
    const res = await fetch(`${baseUrl}${pathOf(id, call.params)}${query}`, {
      method: route.method,
      headers: {
        ...(route.auth === "token" ? auth : {}),
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new ProtocolError(id, res.status, text);
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  return {
    call,

    async health(): Promise<{ ok: boolean }> {
      return (await call<{ ok: boolean }>("health")).body;
    },

    async createConversation(input: { key?: string } = {}): Promise<ConversationCreated> {
      return (await call<ConversationCreated>("conversations.create", { body: input })).body;
    },

    async listConversations(): Promise<ConversationListing[]> {
      return (await call<{ conversations: ConversationListing[] }>("conversations.list")).body
        .conversations;
    },

    async readConversation(id: string): Promise<ConversationEntries> {
      return (await call<ConversationEntries>("conversations.get", { params: { id } })).body;
    },

    async submit(
      id: string,
      content: string,
      submit: SubmitOptions = {},
    ): Promise<SubmissionAnswered> {
      const { wait, ...rest } = submit;
      return (
        await call<SubmissionAccepted | SubmissionAnswered>("conversations.submit", {
          params: { id },
          ...(wait ? { query: { wait: "true" } } : {}),
          body: { content, ...rest },
        })
      ).body;
    },

    async abort(id: string): Promise<void> {
      await call("conversations.abort", { params: { id } });
    },

    /** Open proposals: every conversation's (the inbox), or one conversation's. */
    async listProposals(conversationId?: string): Promise<Proposal[]> {
      const res =
        conversationId === undefined
          ? await call<{ proposals: Proposal[] }>("proposals.list")
          : await call<{ proposals: Proposal[] }>("conversations.proposals", {
              params: { id: conversationId },
            });
      return res.body.proposals;
    },

    /** Decide an open proposal; with `conversationId` it must belong to that conversation. */
    async decide(decision: GateDecision, scope: { conversationId?: string } = {}): Promise<void> {
      const { proposalId, ...body } = decision;
      if (scope.conversationId === undefined) {
        await call("proposals.decide", { params: { pid: proposalId }, body });
      } else {
        await call("conversations.decide", {
          params: { id: scope.conversationId, pid: proposalId },
          body,
        });
      }
    },

    /** Watch a conversation: `onFrame` gets the snapshot, then live event batches. */
    async watch(id: string, onFrame: (frame: WatchFrame) => void): Promise<{ close(): void }> {
      const url = `${baseUrl.replace(/^http/, "ws")}${pathOf("conversations.watch", { id })}`;
      const socket = new WebSocket(url, { headers: auth });
      socket.on("message", (data) => {
        onFrame(JSON.parse((data as Buffer).toString("utf8")) as WatchFrame);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return { close: () => socket.close() };
    },
  };
}

export type ReeworkClient = ReturnType<typeof createClient>;
