import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { gatedAction, listOpenProposals } from "@reework/core";
import { ENGINE_TEST_MODELS } from "./durable/model-setup.js";
import {
  CONTEXT,
  Engine,
  toExtension,
  toDurableTool,
  installHITL,
  settleGate,
} from "@reework/core/internal";

const open: Engine[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  while (open.length > 0) {
    const engine = open.pop()!;
    await engine.close();
  }
});

describe("an agent-driven run invokes the gated-action tool", () => {
  it("opens a gate and suspends when the agent calls the tool during a run", async () => {
    const registry = createRegistry();
    installHITL(registry);
    const applyRollback = gatedAction({
      name: "apply.rollback",
      gate: {
        title: "Apply rollback?",
        options: [{ id: "rollback", label: "Roll back" }],
        acceptFreeForm: true,
      },
      async run(_ctx, _decision) {
        return "rolled back";
      },
    });
    registry.install(toExtension("gated", { tools: [applyRollback] }));

    const models = ENGINE_TEST_MODELS();
    models.setResponses([
      fauxAssistantMessage([fauxToolCall("apply.rollback", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);
    const root = await engine.root({
      model: { provider: "faux", modelId: "faux-1" },
      tools: [toDurableTool(applyRollback)],
      modelTools: [toDurableTool(applyRollback)],
    });
    engine.resume();
    await root.submit({ type: "input", content: "do it" }, CONTEXT);

    // The run invoked the gated tool, which opened a gate on the conversation.
    let opened = false;
    for (let i = 0; i < 200; i += 1) {
      const proposals = await listOpenProposals(engine);
      if (proposals.some((p) => p.conversationId === String(root.id))) {
        opened = true;
        break;
      }
      await sleep(30);
    }
    expect(opened).toBe(true);

    // Settle the gate so the engine tears down cleanly.
    const proposal = (await listOpenProposals(engine)).find(
      (p) => p.conversationId === String(root.id),
    )!;
    await settleGate(engine, {
      proposalId: proposal.id,
      selectedOption: "rollback",
      instruction: null,
    });
    await sleep(1000);
  });
});
