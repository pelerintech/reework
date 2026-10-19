import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Engine, createServer } from "@reework/core";
import { ENGINE_TEST_MODELS } from "../durable/model-setup.js";

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

describe("WebSocket streams live agent events", () => {
  it("connects a WS client to the server and receives live events during a run", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("streamed answer")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);
    const root = await engine.root();

    const { app, nodeWebSocket } = createServer(engine);

    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      nodeWebSocket.injectWebSocket(server);
      void info;
    });

    // Wait for the server to bind and get its ephemeral port.
    const address = server.address() as { port: number };
    const url = `ws://127.0.0.1:${address.port}/conversations/${root.id}/ws`;

    const messages: string[] = [];
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : "";
      messages.push(text);
    });

    // Run an agent so live events flow to the WS client.
    await engine.run("stream it");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("events") || m.includes("snapshot"))).toBe(true);

    ws.close();
    server.close();
  });
});
