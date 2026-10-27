import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import type { ActionOutcome } from "@reework/core";
import {
  CONTEXT,
  Engine,
  installHITL,
  openGatedAction,
  settleGate,
  waitForOutcome,
} from "@reework/core/internal";

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

async function isWaiting(engine: Engine, actionId: unknown): Promise<boolean> {
  const graph = await engine.harness.taskGraph(CONTEXT);
  const node = Object.values(graph.value.tasks).find((n) => n.id === actionId);
  return node?.state.status === "waiting";
}

describe("crash mid-gate then restart", () => {
  it("resumes the gated action on the human's decision after a restart", async () => {
    const path = tmpPath();
    const proposal = {
      id: "gate-crash",
      title: "Choose remediation",
      options: [
        { id: "refund", label: "Refund" },
        { id: "retry", label: "Retry" },
      ],
      acceptFreeForm: false,
    };

    // Engine A: suspend an action on an open gate, then crash (abandon).
    const registryA = createRegistry();
    installHITL(registryA);
    const engineA = await Engine.open({ storagePath: path, registry: registryA });
    const actionId = await openGatedAction(engineA, proposal);
    engineA.resume();
    for (let i = 0; i < 50 && !(await isWaiting(engineA, actionId)); i += 1) {
      await sleep(50);
    }
    expect(await isWaiting(engineA, actionId)).toBe(true);
    // Simulated crash: engineA is left, never settled, never closed.

    // Engine B: fresh session over the same storage; then the human decides.
    const registryB = createRegistry();
    installHITL(registryB);
    const engineB = await Engine.open({ storagePath: path, registry: registryB });
    open.push(engineB);
    engineB.resume();
    // Let the restarted scheduler re-run the awaiting gate before settling.
    for (let i = 0; i < 50; i += 1) {
      const graph = await engineB.harness.taskGraph(CONTEXT);
      const gate = Object.values(graph.value.tasks).find((n) => n.kind === "rework.gate");
      if (gate?.state.status === "running") break;
      await sleep(50);
    }

    await settleGate(engineB, {
      proposalId: proposal.id,
      selectedOption: "refund",
      instruction: null,
    });

    const outcome = await waitForOutcome<ActionOutcome>(engineB, actionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("refund");
    expect(outcome.result!.decision.selectedOption).toBe("refund");
  });
});
