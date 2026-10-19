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

describe("human selects an offered option", () => {
  it("branches the resuming action to the selected option", async () => {
    const engine = await makeEngine();
    const proposal = {
      id: "gate-option",
      title: "How should we remediate?",
      options: [
        { id: "refund", label: "Refund" },
        { id: "retry", label: "Retry" },
      ],
      acceptFreeForm: false,
    };
    const actionId = await openGatedAction(engine, proposal);
    await settleGate(engine, {
      proposalId: proposal.id,
      selectedOption: "refund",
      instruction: null,
    });

    const outcome = await waitForOutcome<ActionOutcome>(engine, actionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("refund");
    expect(outcome.result!.decision.selectedOption).toBe("refund");
  });
});
