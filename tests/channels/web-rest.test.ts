import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Engine, WebChannel } from "@reework/core";
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

describe("web channel REST contract", () => {
  it("sends a user message via the REST contract and gets a response from the engine", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("hello from the engine")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);

    const web = new WebChannel(engine);
    const root = await engine.root();
    const res = await web.rest.sendMessage({ conversationId: String(root.id), text: "hi" });
    expect(res.conversationId).toBe(String(root.id));
    expect(res.result).toContain("hello from the engine");
  });
});
