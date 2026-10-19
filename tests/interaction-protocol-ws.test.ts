import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@reework/types";
import { Engine, createServer } from "@reework/core";
import { ENGINE_TEST_MODELS } from "./durable/model-setup.js";

const open: Engine[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

afterEach(async () => {
  while (open.length > 0) {
    const engine = open.pop()!;
    await engine.close();
  }
});

describe("interaction protocol: a client streams live agent events over WS", () => {
  it("delivers streaming AgentEvents shaped like the shared vocabulary", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("streamed over ws")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);
    const root = await engine.root();

    const { app, nodeWebSocket } = createServer(engine);
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      nodeWebSocket.injectWebSocket(server);
      void info;
    });
    const address = server.address() as { port: number };
    const url = `ws://127.0.0.1:${address.port}/conversations/${root.id}/ws`;

    const events: AgentEvent[] = [];
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : "";
      const parsed = JSON.parse(text) as { kind: string; events?: AgentEvent[] };
      if (Array.isArray(parsed.events)) events.push(...parsed.events);
    });

    await engine.run("stream it");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The client receives events in the shared AgentEvent shape (kind + conversationId + timestamp).
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.kind).toBe("string");
      expect(event.conversationId).toBe(String(root.id));
      expect(typeof event.timestamp).toBe("number");
    }

    ws.close();
    server.close();
  });
});
