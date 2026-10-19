import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@reework/types";
import { createRegistry } from "@earendil-works/pi-durable";
import { Engine, createServer, installHITL, openGatedAction, waitForOutcome } from "@reework/core";
import type { ActionOutcome } from "@reework/core";
import { TuiProtocolClient } from "@reework/tui";
import { ENGINE_TEST_MODELS } from "./durable/model-setup.js";

const open: Engine[] = [];
const servers: ServerType[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()!.close();
  }
  while (open.length > 0) {
    const engine = open.pop()!;
    await engine.close();
  }
});

async function startServer(): Promise<{ engine: Engine; baseUrl: string; conversationId: string }> {
  const models = ENGINE_TEST_MODELS();
  models.setResponses([fauxAssistantMessage("the tui got an answer")]);
  const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
  open.push(engine);
  const root = await engine.root();
  const { app, nodeWebSocket } = createServer(engine);
  const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
    nodeWebSocket.injectWebSocket(server);
    void info;
  });
  servers.push(server);
  const address = server.address() as { port: number };
  return { engine, baseUrl: `http://127.0.0.1:${address.port}`, conversationId: String(root.id) };
}

describe("TUI protocol client connects to an agent server", () => {
  it("connects via the event stream and submits input / reads the conversation over REST", async () => {
    const { baseUrl, conversationId } = await startServer();
    const client = new TuiProtocolClient({ baseUrl });

    // Submits input and reads the typed outcome over REST.
    const message = await client.submitInput(conversationId, "hello");
    expect(message.role).toBe("assistant");
    expect(JSON.stringify(message.content)).toContain("the tui got an answer");

    // Reads the conversation's entries over REST.
    const conversation = await client.readConversation(conversationId);
    expect(conversation.id).toBe(conversationId);
    expect(conversation.entries.length).toBeGreaterThan(0);

    // Connects to the live event stream over WS.
    const received: AgentEvent[] = [];
    const disconnect = await client.connect(conversationId, (events) => received.push(...events));
    expect(typeof disconnect).toBe("function");
    await new Promise((resolve) => setTimeout(resolve, 100));
    disconnect();
  });

  it("lets the operator list an open gate and answer it via a decision", async () => {
    const models = ENGINE_TEST_MODELS();
    const registry = createRegistry();
    installHITL(registry);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);
    const root = await engine.root();
    const { app, nodeWebSocket } = createServer(engine);
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      nodeWebSocket.injectWebSocket(server);
      void info;
    });
    servers.push(server);
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const conversationId = String(root.id);

    // Open a gate on the server's conversation.
    const actionId = await openGatedAction(engine, {
      id: "tui-gate",
      title: "Approve?",
      options: [{ id: "yes", label: "Yes" }],
      acceptFreeForm: false,
    });

    const client = new TuiProtocolClient({ baseUrl });
    const proposals = await client.listProposals(conversationId);
    expect(proposals.some((p) => p.id === "tui-gate")).toBe(true);

    await client.submitDecision(conversationId, {
      proposalId: "tui-gate",
      selectedOption: "yes",
      instruction: null,
    });
    const outcome = await waitForOutcome<ActionOutcome>(engine, actionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("yes");
  });

  it("keeps the server running after the TUI client disconnects", async () => {
    const { baseUrl, conversationId } = await startServer();
    const client = new TuiProtocolClient({ baseUrl });

    const disconnect = await client.connect(conversationId, () => {});
    disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The server is independent of the client: it still serves requests.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // And it still processes input after the client detached.
    const message = await client.submitInput(conversationId, "still here");
    expect(message.role).toBe("assistant");
  });
});
