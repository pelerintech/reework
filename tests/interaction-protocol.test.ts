import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Message, Proposal } from "@reework/types";
import { Engine, createServer, installHITL, openGatedAction, waitForOutcome } from "@reework/core";
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
  it("submits input via POST /conversations/:id/messages and reads a typed message outcome", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("the protocol answered")]);
    const registry = createRegistry();
    installHITL(registry);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);
    const root = await engine.root();
    const { app } = createServer(engine);

    const submit = await app.request(`/conversations/${root.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(submit.status).toBe(200);

    const body = (await submit.json()) as { conversationId: string; message: Message };
    expect(body.conversationId).toBe(String(root.id));
    expect(body.message.role).toBe("assistant");
    expect(JSON.stringify(body.message.content)).toContain("the protocol answered");
  });

  it("lists open proposals and settles a gate via a submitted decision", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([]);
    const registry = createRegistry();
    installHITL(registry);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);
    const root = await engine.root();
    const { app } = createServer(engine);

    const proposalId = "gate-1";
    const actionId = await openGatedAction(engine, {
      id: proposalId,
      title: "Apply rollback?",
      options: [{ id: "rollback", label: "Roll back" }],
      acceptFreeForm: true,
    });

    // The open proposal is listed via the protocol.
    const list = await app.request(`/conversations/${root.id}/proposals`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { proposals: Proposal[] };
    expect(listed.proposals.some((p) => p.id === proposalId)).toBe(true);

    // Submitting a decision settles the gate and the gated action resumes.
    const decision = await app.request(
      `/conversations/${root.id}/proposals/${proposalId}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId, selectedOption: "rollback", instruction: null }),
      },
    );
    expect(decision.status).toBe(200);

    const outcome = await waitForOutcome<ActionOutcome>(engine, actionId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result!.branch).toBe("rollback");
  });
});
