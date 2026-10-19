import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("Hono REST exposes a conversation", () => {
  it("submits a message and reads the conversation via app.request()", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("the server answered")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);
    const { app } = createServer(engine);
    const root = await engine.root();

    const submit = await app.request(`/conversations/${root.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(submit.status).toBe(200);
    const body = (await submit.json()) as { conversationId: string; result: string };
    expect(body.conversationId).toBe(String(root.id));
    expect(body.result).toContain("the server answered");

    const read = await app.request(`/conversations/${root.id}`);
    expect(read.status).toBe(200);
    const view = (await read.json()) as { id: string; entries: unknown[] };
    expect(view.id).toBe(String(root.id));
    expect(view.entries.length).toBeGreaterThan(0);
  });
});
