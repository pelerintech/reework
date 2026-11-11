// @reework/client — the protocol client the TUI, agent projects, and external
// systems use. Every call is built from the shared `ROUTES` table.
import WebSocket from "ws";
import { ROUTES } from "@reework/types";
import type {
  AgentEvent,
  Author,
  Case,
  CaseKind,
  CasePatch,
  CasePriority,
  ConversationCreated,
  FileRecord,
  GateDecision,
  Message,
  Proposal,
  RouteId,
  SnapshotEvent,
  SubmissionAccepted,
  SubmissionAnswered,
  TranscriptItem,
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
  /** File ids of this conversation to name in the input. */
  readonly files?: readonly string[];
  /** Who the input is from; absent means unattributed (never assumed human). */
  readonly from?: Author;
}

/** A frame of `watch`: the snapshot first, then batches of live events. */
export type WatchFrame =
  | (SnapshotEvent & {
      messages: Message[];
      proposals: Proposal[];
      running: boolean;
      transcript: TranscriptItem[];
    })
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

    /** Call a plugin route under `/plugins/<name>`, with the bearer token. */
    plugin(name: string) {
      return {
        request(path: string, init: RequestInit = {}): Promise<Response> {
          if (!path.startsWith("/")) throw new Error(`plugin request path must start with "/"`);
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${options.token}`);
          return fetch(`${baseUrl}/plugins/${name}${path}`, { ...init, headers });
        },
      };
    },

    /** Liveness, and the agent's name. */
    async health(): Promise<{ ok: boolean; name?: string }> {
      return (await call<{ ok: boolean; name?: string }>("health")).body;
    },

    async createConversation(
      input: {
        key?: string;
        /** `case` (default) or `desk`. */
        kind?: CaseKind;
        /** Initial case fields. */
        case?: { title?: string; priority?: CasePriority; owner?: Author };
      } = {},
    ): Promise<ConversationCreated> {
      return (await call<ConversationCreated>("conversations.create", { body: input })).body;
    },

    async listConversations(): Promise<ConversationListing[]> {
      return (await call<{ conversations: ConversationListing[] }>("conversations.list")).body
        .conversations;
    },

    /** Every conversation's case, newest first; `status`/`tag`/`needsHuman`/`stage`/`kind`/`owner`/`sort` filter. */
    async listCases(
      filter: {
        status?: string[];
        tag?: string[];
        needsHuman?: boolean;
        stage?: string;
        kind?: CaseKind[];
        owner?: Author;
        sort?: "priority" | "dueAt" | "createdAt" | "updatedAt";
      } = {},
    ): Promise<Case[]> {
      const query: Record<string, string> = {};
      if (filter.status?.length) query.status = filter.status.join(",");
      if (filter.tag?.length) query.tag = filter.tag.join(",");
      if (filter.needsHuman !== undefined) query.needsHuman = String(filter.needsHuman);
      if (filter.stage) query.stage = filter.stage;
      if (filter.kind?.length) query.kind = filter.kind.join(",");
      if (filter.owner) {
        query.ownerKind = filter.owner.kind;
        if (filter.owner.id) query.ownerId = filter.owner.id;
      }
      if (filter.sort) query.sort = filter.sort;
      const res = await call<{ cases: Case[] }>("conversations.list", { query });
      return res.body.cases;
    },

    async getCase(id: string): Promise<Case> {
      return (await call<Case>("conversations.getCase", { params: { id } })).body;
    },

    async updateCase(id: string, patch: CasePatch): Promise<Case> {
      return (await call<Case>("conversations.updateCase", { params: { id }, body: patch })).body;
    },

    async readConversation(id: string): Promise<ConversationEntries> {
      return (await call<ConversationEntries>("conversations.get", { params: { id } })).body;
    },

    /** A conversation's files, oldest first. */
    async listFiles(id: string): Promise<FileRecord[]> {
      return (await call<{ files: FileRecord[] }>("conversations.files", { params: { id } })).body
        .files;
    },

    /** Upload bytes to a conversation; returns the stored record. */
    async uploadFile(
      id: string,
      input: { name: string; mimeType?: string; bytes: Uint8Array },
    ): Promise<FileRecord> {
      const res = await fetch(
        `${baseUrl}${pathOf("conversations.uploadFile", { id })}?name=${encodeURIComponent(input.name)}`,
        {
          method: "POST",
          headers: { ...auth, ...(input.mimeType ? { "content-type": input.mimeType } : {}) },
          body: input.bytes,
        },
      );
      if (!res.ok) {
        throw new ProtocolError("conversations.uploadFile", res.status, await res.text());
      }
      return (await res.json()) as FileRecord;
    },

    /** Download a file's bytes; name and type come from the response headers. */
    async downloadFile(
      id: string,
      fid: string,
    ): Promise<{ bytes: Uint8Array; name?: string; mimeType?: string }> {
      const res = await fetch(`${baseUrl}${pathOf("conversations.downloadFile", { id, fid })}`, {
        headers: auth,
      });
      if (!res.ok) {
        throw new ProtocolError("conversations.downloadFile", res.status, await res.text());
      }
      const name = /filename="([^"]*)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const mimeType = res.headers.get("content-type") ?? undefined;
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        ...(name ? { name } : {}),
        ...(mimeType ? { mimeType } : {}),
      };
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

    /**
     * Proposals across every conversation (the inbox) or one conversation's.
     * Open by default; `status: "settled"` returns settled ones with their
     * decision and decider. A bare string is a conversation id (legacy form).
     */
    async listProposals(
      options?: string | { conversationId?: string; status?: "open" | "settled" },
    ): Promise<Proposal[]> {
      const opts = typeof options === "string" ? { conversationId: options } : (options ?? {});
      const query = opts.status === undefined ? undefined : { status: opts.status };
      const res =
        opts.conversationId === undefined
          ? await call<{ proposals: Proposal[] }>("proposals.list", { query })
          : await call<{ proposals: Proposal[] }>("conversations.proposals", {
              params: { id: opts.conversationId },
              query,
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

export { applyFrame, emptyView } from "./view.ts";
export type { ConversationView, ViewItem, ViewMessage, ViewTool } from "./view.ts";
