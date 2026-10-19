import type { AgentEvent, GateDecision, Message, Proposal } from "@reework/types";
import WebSocket from "ws";

export interface TuiClientOptions {
  /** Base URL of the agent server, e.g. `http://127.0.0.1:3000`. */
  baseUrl: string;
}

/**
 * The TUI's protocol client: a thin consumer of the agent server's interaction
 * protocol — WebSocket for live agent events, REST for submitting input,
 * reading a conversation, listing proposals, and submitting gate decisions.
 * It is a separate client process; its failure does not affect the server.
 */
export class TuiProtocolClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;

  constructor(options: TuiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.wsUrl = this.baseUrl.replace(/^http/, "ws");
  }

  /** Open a WS event stream for a conversation. Returns an unsubscribe fn. */
  async connect(
    conversationId: string,
    listener: (events: AgentEvent[]) => void,
  ): Promise<() => void> {
    const socket = new WebSocket(`${this.wsUrl}/conversations/${conversationId}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    socket.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : "";
      const parsed = JSON.parse(raw) as { kind: string; events?: AgentEvent[] };
      if (Array.isArray(parsed.events)) {
        listener(parsed.events);
      }
    });
    return () => socket.close();
  }

  /** Submit input to a conversation; returns the assistant's typed message. */
  async submitInput(conversationId: string, content: string): Promise<Message> {
    const res = await fetch(`${this.baseUrl}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const body = (await res.json()) as { message: Message };
    return body.message;
  }

  /** Read a conversation's entries. */
  async readConversation(conversationId: string): Promise<{ id: string; entries: unknown[] }> {
    const res = await fetch(`${this.baseUrl}/conversations/${conversationId}`);
    return (await res.json()) as { id: string; entries: unknown[] };
  }

  /** List the open gate proposals. */
  async listProposals(conversationId: string): Promise<Proposal[]> {
    const res = await fetch(`${this.baseUrl}/conversations/${conversationId}/proposals`);
    const body = (await res.json()) as { proposals: Proposal[] };
    return body.proposals;
  }

  /** Submit a gate decision; settles the gate. */
  async submitDecision(conversationId: string, decision: GateDecision): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/conversations/${conversationId}/proposals/${decision.proposalId}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision),
      },
    );
    if (!res.ok) {
      throw new Error(`decision submit failed: ${res.status}`);
    }
  }
}
