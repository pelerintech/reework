import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import {
  CONTEXT,
  Engine,
  installHITL,
  openBackgroundTask,
  openGatedAction,
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

function makeEngine() {
  const registry = createRegistry();
  installHITL(registry);
  return Engine.open({ storagePath: tmpPath(), registry });
}

describe("opening a gate suspends only the gated action", () => {
  it("suspends the gated action while other work keeps running", async () => {
    const engine = await makeEngine();
    open.push(engine);

    const proposal = { id: "gate-1", title: "Approve payment", options: [], acceptFreeForm: true };
    const actionId = await openGatedAction(engine, proposal);
    const backgroundId = await openBackgroundTask(engine);

    // Other work completes while the action is still waiting on the gate.
    const backgroundOutcome = await waitForOutcome<{ note: string }>(engine, backgroundId);
    expect(backgroundOutcome.status).toBe("completed");
    expect(backgroundOutcome.result!.note).toBe("done");

    // The gated action has not completed — it is suspended at the gate.
    const graph = await engine.harness.taskGraph(CONTEXT);
    const node = Object.values(graph.value.tasks).find((n) => n.id === actionId);
    expect(node).toBeDefined();
    expect(node?.state.status).toBe("waiting");
  });
});
