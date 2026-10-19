import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { isChannel } from "@reework/types";
import { Engine, WebChannel, WhatsAppChannel } from "@reework/core";
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

describe("WhatsApp channel", () => {
  it("satisfies the same Channel contract as the web channel (transport may be stubbed)", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("whatsapp handled it")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);

    const whatsapp = new WhatsAppChannel(engine);
    const web = new WebChannel(engine);

    // Both satisfy the same Channel contract type.
    expect(isChannel(whatsapp)).toBe(true);
    expect(isChannel(web)).toBe(true);

    // A message delivered through the WhatsApp transport is handled by the contract.
    const root = await engine.root();
    const res = await whatsapp.rest.sendMessage({ conversationId: String(root.id), text: "hi" });
    expect(res.result).toContain("whatsapp handled it");
  });
});
