// A gate settles atomically: the decision and the proposal's settled status are
// written in one engine commit, so a crash can never leave a decided-but-open
// proposal that a later decision could re-decide.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import type { CommitPublication } from "@earendil-works/pi-durable";
import { listOpenProposals } from "@reework/core";
import { Engine, installHITL, openGatedAction, settleGate } from "@reework/core/internal";

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

describe("settling a gate", () => {
  it("writes the decision and the settled proposal in one commit", async () => {
    const engine = await makeEngine();
    await openGatedAction(engine, {
      id: "g-atomic",
      title: "Deploy?",
      options: [{ id: "go", label: "Go" }],
      acceptFreeForm: false,
    });

    // The harness publishes every complete commit; a document change names its
    // definition kind and, for a family, its key.
    const commits: CommitPublication[] = [];
    const stop = engine.harness.subscribeCommits((publication) => commits.push(publication));
    await settleGate(engine, {
      proposalId: "g-atomic",
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    stop();

    const deciding = commits.filter((publication) =>
      publication.changes.some(
        (change) =>
          change.type === "document" &&
          change.record.kind === "rework.gateDecision" &&
          change.record.key === "g-atomic",
      ),
    );
    expect(deciding).toHaveLength(1);
    const kinds = deciding[0]!.changes.flatMap((change) =>
      change.type === "document" ? [change.record.kind] : [],
    );
    expect(kinds).toContain("rework.proposals");

    expect(await listOpenProposals(engine)).toEqual([]);
  });
});
