import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@reework/types";
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

describe("web channel WS contract", () => {
  it("streams live agent events to a WS client over the channel's WS contract", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("the live answer")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);

    const web = new WebChannel(engine);
    const root = await engine.root();

    const received: AgentEvent[] = [];
    const stream = await web.ws.watchEvents(String(root.id), (events) => {
      received.push(...events);
    });

    // Run an agent; events flow to the WS listener as the run progresses.
    await engine.run("drive it");

    // The listener is invoked asynchronously per commit; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const kinds = new Set(received.map((e) => e.kind));
    expect(kinds.has("message_start") || kinds.has("run_start")).toBe(true);
    expect(stream.snapshot).toBeDefined();
  });
});
