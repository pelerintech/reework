import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Proposal } from "@reework/types";
import {
  CONTEXT,
  Engine,
  installHITL,
  onProposalOpen,
  openGatedAction,
  settleGate,
  waitForOutcome,
} from "@reework/core";
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

describe("channel ↔ gate wiring", () => {
  it("publishes an open proposal observable (in-process) to a channel", async () => {
    const registry = createRegistry();
    installHITL(registry);
    const engine = await Engine.open({ storagePath: tmpPath(), registry });
    open.push(engine);

    // A stub channel watches the protocol's proposal stream in-process.
    const observed: Proposal[] = [];
    const unsubscribe = onProposalOpen((proposal) => observed.push(proposal));

    const proposal = { id: "gate-1", title: "Apply rollback?", options: [], acceptFreeForm: true };
    const actionId = await openGatedAction(engine, proposal);

    // The channel received the open proposal.
    expect(observed.some((p) => p.id === proposal.id)).toBe(true);

    unsubscribe();
    // Clean up so the engine tears down.
    await settleGate(engine, {
      proposalId: proposal.id,
      selectedOption: null,
      instruction: "proceed",
    });
    const action = await engine.harness.waitForTask(actionId, CONTEXT);
    expect(action.state.outcome?.status).toBe("completed");
  });

  it("routes a channel's in-process decision back to the gate and resumes the action", async () => {
    const registry = createRegistry();
    installHITL(registry);
    const engine = await Engine.open({ storagePath: tmpPath(), registry });
    open.push(engine);

    const proposal = {
      id: "gate-2",
      title: "Pick a path",
      options: [{ id: "a", label: "A" }],
      acceptFreeForm: true,
    };
    const actionId = await openGatedAction(engine, proposal);

    // A stub channel submits a decision in-process (the host routes it to settleGate).
    await settleGate(engine, { proposalId: proposal.id, selectedOption: "a", instruction: null });

    const outcome = await waitForOutcome<ActionOutcome>(engine, actionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("a");
  });

  it("keeps a recorded channel decision durable across a restart", async () => {
    const path = tmpPath();
    const proposal = {
      id: "gate-3",
      title: "Approve",
      options: [{ id: "yes", label: "Yes" }],
      acceptFreeForm: false,
    };

    // Engine A: record the decision via the channel path, then the process ends
    // before the gate consumes it (the gate task never starts its awaiting phase).
    const registryA = createRegistry();
    installHITL(registryA);
    const engineA = await Engine.open({ storagePath: path, registry: registryA });
    const actionA = await openGatedAction(engineA, proposal);
    await settleGate(engineA, {
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
    });
    await engineA.close();

    // Engine B: a fresh session over the same storage; the gate reads the
    // recorded decision durably and settles on resume.
    const registryB = createRegistry();
    installHITL(registryB);
    const engineB = await Engine.open({ storagePath: path, registry: registryB });
    open.push(engineB);
    engineB.resume();

    const outcome = await waitForOutcome<ActionOutcome>(engineB, actionA);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("yes");
  });
});
