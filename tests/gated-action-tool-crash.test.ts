import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  CONTEXT,
  Engine,
  definePlugin,
  gatedAction,
  installHITL,
  installPlugin,
  listOpenProposals,
  settleGate,
} from "@reework/core";
import { ENGINE_TEST_MODELS } from "./durable/model-setup.js";

const open: Engine[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

async function waitForGateRunning(engine: Engine): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    const graph = await engine.harness.taskGraph(CONTEXT);
    const gate = Object.values(graph.value.tasks).find((n) => n.kind === "rework.gate");
    if (gate?.state.status === "running") return true;
    await sleep(30);
  }
  return false;
}

afterEach(async () => {
  while (open.length > 0) {
    const engine = open.pop()!;
    await engine.close();
  }
});

async function waitForGate(engine: Engine, conversationId: string): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    const proposals = await listOpenProposals(engine);
    if (proposals.some((p) => p.conversationId === conversationId)) return true;
    await sleep(30);
  }
  return false;
}

describe("a gated action survives crash mid-gate", () => {
  it("resumes on the human's decision after a crash, not restarting from scratch", async () => {
    const path = tmpPath();
    const branches: string[] = [];
    const runBranches = (branch: string) => {
      branches.push(branch);
      return branch;
    };

    const makeTool = () =>
      gatedAction({
        name: "apply.rollback",
        gate: {
          title: "Apply rollback?",
          options: [{ id: "rollback", label: "Roll back" }],
          acceptFreeForm: false,
        },
        async run(_ctx, decision) {
          return runBranches(decision.selectedOption ?? "none");
        },
      });

    // Engine A: boot, submit, open the gate, then crash (abandon without close).
    const registryA = createRegistry();
    installHITL(registryA);
    const applyA = makeTool();
    installPlugin(definePlugin({ name: "gated", tools: [applyA] }), registryA);
    const modelsA = ENGINE_TEST_MODELS();
    modelsA.setResponses([
      fauxAssistantMessage([fauxToolCall("apply.rollback", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const engineA = await Engine.open({
      storagePath: path,
      models: modelsA.models,
      registry: registryA,
    });
    const rootA = await engineA.root({
      model: { provider: "faux", modelId: "faux-1" },
      tools: [applyA],
      modelTools: [applyA],
    });
    engineA.resume();
    const submissionA = await rootA.submit({ type: "input", content: "do it" }, CONTEXT);
    expect(await waitForGate(engineA, String(rootA.id))).toBe(true);
    // Let engineA quiesce (all writes flushed) before the simulated crash.
    await sleep(300);
    // Simulated crash: engineA abandoned, never settled, never closed.

    // Engine B: reopen over the same storage; then the human decides.
    const registryB = createRegistry();
    installHITL(registryB);
    const applyB = makeTool();
    installPlugin(definePlugin({ name: "gated", tools: [applyB] }), registryB);
    const modelsB = ENGINE_TEST_MODELS();
    modelsB.setResponses([fauxAssistantMessage("done")]);
    const engineB = await Engine.open({
      storagePath: path,
      models: modelsB.models,
      registry: registryB,
    });
    open.push(engineB);
    engineB.resume();

    const conversationId = String(rootA.id);
    expect(await waitForGate(engineB, conversationId)).toBe(true);
    // Let the restarted scheduler re-run the awaiting gate before settling.
    expect(await waitForGateRunning(engineB)).toBe(true);

    const proposal = (await listOpenProposals(engineB)).find(
      (p) => p.conversationId === conversationId,
    )!;
    await settleGate(engineB, {
      proposalId: proposal.id,
      selectedOption: "rollback",
      instruction: null,
    });

    // Drive the restarted run to completion, then confirm the gated action resumed
    // on the decision (branched to rollback), not restarting from scratch.
    const subB = await engineB.harness.submission(submissionA.id, CONTEXT);
    const settled = await subB!.wait(CONTEXT);
    expect(settled.status).toBe("done");
    expect(await waitFor(() => branches.length > 0, 8000)).toBe(true);
    expect(branches).toEqual(["rollback"]);
  }, 30000);
});
