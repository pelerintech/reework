import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";

import {
  Engine,
  installHITL,
  openGatedAction,
  settleGate,
  waitForOutcome,
} from "@reework/core/internal";

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

describe("human gives a free-form instruction", () => {
  it("branches the resuming action on the interpreted instruction, not only pre-enumerated options", async () => {
    const engine = await makeEngine();
    const proposal = {
      id: "gate-freeform",
      title: "What next step?",
      options: [],
      acceptFreeForm: true,
    };
    const actionId = await openGatedAction(engine, proposal);
    await settleGate(engine, {
      proposalId: proposal.id,
      selectedOption: null,
      instruction: "Call the manager before proceeding",
    });

    const outcome = await waitForOutcome<ActionOutcome>(engine, actionId);
    expect(outcome.status).toBe("completed");
    // Branch is the interpreted outcome from the free-form instruction.
    expect(outcome.result!.branch).toBe("instruction");
    expect(outcome.result!.decision.instruction).toContain("manager");
  });
});
