import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  CONTEXT,
  Engine,
  toExtension,
  gatedAction,
  installHITL,
  listOpenProposals,
  openBackgroundTask,
  settleGate,
  waitForOutcome,
} from "@reework/core";
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGate(engine: Engine, conversationId: string): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    const proposals = await listOpenProposals(engine);
    if (proposals.some((p) => p.conversationId === conversationId)) return true;
    await sleep(30);
  }
  return false;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

describe("a gated-action tool suspends only the gated action", () => {
  it("leaves the gated action suspended on its gate while other work completes", async () => {
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
      tools: [applyRollback],
      modelTools: [applyRollback],
    });
    engine.resume();
    const submission = await root.submit({ type: "input", content: "do it" }, CONTEXT);
    const conversationId = String(root.id);

    // Other live work, opened alongside the gated action, completes.
    const backgroundId = await openBackgroundTask(engine);
    const bg = await waitForOutcome<{ note: string }>(engine, backgroundId);
    expect(bg.status).toBe("completed");
    expect(bg.result!.note).toBe("done");

    // The gated action has opened a gate and suspended, while the background work finished.
    expect(await waitForGate(engine, conversationId)).toBe(true);

    // Settle the gate so the run and engine tear down cleanly.
    const proposal = (await listOpenProposals(engine)).find(
      (p) => p.conversationId === conversationId,
    )!;
    await settleGate(engine, {
      proposalId: proposal.id,
      selectedOption: "rollback",
      instruction: null,
    });
    await Promise.race([submission.wait(CONTEXT), sleep(3000)]);
  });

  it("resumes and branches on the human's selected option", async () => {
    const branches: string[] = [];
    const registry = createRegistry();
    installHITL(registry);
    const applyRollback = gatedAction({
      name: "apply.rollback",
      gate: {
        title: "Apply rollback?",
        options: [
          { id: "rollback", label: "Roll back" },
          { id: "investigate", label: "Keep investigating" },
        ],
        acceptFreeForm: true,
      },
      async run(_ctx, decision) {
        if (decision.selectedOption === "rollback") {
          branches.push("rollback");
          return "rolled back";
        }
        branches.push("investigate");
        return "investigating";
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
      tools: [applyRollback],
      modelTools: [applyRollback],
    });
    engine.resume();
    await root.submit({ type: "input", content: "do it" }, CONTEXT);
    const conversationId = String(root.id);

    // Wait for the gate to open, then the human picks the "rollback" option.
    expect(await waitForGate(engine, conversationId)).toBe(true);
    const proposal = (await listOpenProposals(engine)).find(
      (p) => p.conversationId === conversationId,
    )!;
    await settleGate(engine, {
      proposalId: proposal.id,
      selectedOption: "rollback",
      instruction: null,
    });

    // The action resumes and branches on the chosen option.
    expect(await waitFor(() => branches.length > 0)).toBe(true);
    expect(branches).toEqual(["rollback"]);
  });
});
