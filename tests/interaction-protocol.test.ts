import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Proposal } from "@reework/types";
import {
  Engine,
  AgentHost,
  createServer,
  installHITL,
  openGatedAction,
  waitForOutcome,
} from "@reework/core";
import { ENGINE_TEST_MODELS } from "./durable/model-setup.js";
import { createRegistry } from "@earendil-works/pi-durable";
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

describe("interaction protocol: a client submits input and reads the outcome", () => {
  it("lists open proposals and settles a gate via a submitted decision", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([]);
    const registry = createRegistry();
    installHITL(registry);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);
    const { app } = createServer(
      new AgentHost(engine, { model: { provider: "faux", modelId: "faux-1" } }),
      { token: "t" },
    );

    const proposalId = "gate-1";
    const actionId = await openGatedAction(engine, {
      id: proposalId,
      title: "Apply rollback?",
      options: [{ id: "rollback", label: "Roll back" }],
      acceptFreeForm: true,
    });

    // The open proposal is listed via the protocol.
    const list = await app.request(`/proposals`, {
      headers: { authorization: "Bearer t" },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { proposals: Proposal[] };
    expect(listed.proposals.some((p) => p.id === proposalId)).toBe(true);

    // Submitting a decision settles the gate and the gated action resumes.
    const decision = await app.request(`/proposals/${proposalId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ proposalId, selectedOption: "rollback", instruction: null }),
    });
    expect(decision.status).toBe(200);

    const outcome = await waitForOutcome<ActionOutcome>(engine, actionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("rollback");
  });
});
