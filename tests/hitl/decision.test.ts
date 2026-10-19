import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { Engine, installHITL, openGatedAction, settleGate, waitForOutcome } from "@reework/core";
import type { ActionOutcome } from "@reework/core";

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

async function makeEngine() {
  const registry = createRegistry();
  installHITL(registry);
  const engine = await Engine.open({ storagePath: tmpPath(), registry });
  open.push(engine);
  return engine;
}

describe("gate decision record is business-flow-driven", () => {
  it("records option-only, free-form-only, and both decision types on their matching branch", async () => {
    const engine = await makeEngine();

    // Option-only gate.
    const optId = await openGatedAction(engine, {
      id: "g-opt",
      title: "Pick",
      options: [{ id: "a", label: "A" }],
      acceptFreeForm: false,
    });
    await settleGate(engine, { proposalId: "g-opt", selectedOption: "a", instruction: null });
    const opt = await waitForOutcome<ActionOutcome>(engine, optId);
    expect(opt.result!.branch).toBe("a");
    expect(opt.result!.decision.selectedOption).toBe("a");

    // Free-form-only gate.
    const ffId = await openGatedAction(engine, {
      id: "g-ff",
      title: "Directions",
      options: [],
      acceptFreeForm: true,
    });
    await settleGate(engine, {
      proposalId: "g-ff",
      selectedOption: null,
      instruction: "do the other thing",
    });
    const ff = await waitForOutcome<ActionOutcome>(engine, ffId);
    expect(ff.result!.branch).toBe("instruction");
    expect(ff.result!.decision.instruction).toBe("do the other thing");

    // Both options and free-form.
    const bothId = await openGatedAction(engine, {
      id: "g-both",
      title: "Decide",
      options: [{ id: "x", label: "X" }],
      acceptFreeForm: true,
    });
    await settleGate(engine, { proposalId: "g-both", selectedOption: "x", instruction: "fast" });
    const both = await waitForOutcome<ActionOutcome>(engine, bothId);
    expect(both.result!.branch).toBe("x");
    expect(both.result!.decision.selectedOption).toBe("x");
    expect(both.result!.decision.instruction).toBe("fast");
  });
});
