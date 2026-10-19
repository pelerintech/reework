import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { CONTEXT, Engine, definePlugin, defineTool, installPlugin } from "@reework/core";
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

// A plugin that only reaches the core through the facade (no pi-durable imports).
const SummaryTool = defineTool({
  name: "summarize",
  description: "Summarize the conversation.",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute(_args) {
    return { output: [{ type: "text", text: "summary done" }] };
  },
});

const FacadePlugin = definePlugin({
  name: "facade-plugin",
  tools: [SummaryTool],
});

describe("plugins and tools reach the core through the facade", () => {
  it("installs a facade-defined tool the agent can call", async () => {
    const registry = createRegistry();
    installPlugin(FacadePlugin, registry);

    const models = ENGINE_TEST_MODELS();
    models.setResponses([
      fauxAssistantMessage([fauxToolCall("summarize", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);
    const root = await engine.root({
      model: { provider: "faux", modelId: "faux-1" },
      tools: [SummaryTool],
      modelTools: [SummaryTool],
    });
    engine.resume();
    const submission = await root.submit({ type: "input", content: "do it" }, CONTEXT);
    const settled = await submission.wait(CONTEXT);
    expect(settled.status).toBe("done");
  });
});
