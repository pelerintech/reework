// Storage written before case fields existed reads as cases with defaults, and
// updates made on it survive a restart.
import { afterEach, describe, expect, it } from "vitest";
import { createMockModels, startTestAgent } from "@reework/core/testing";
import { ConversationsDoc, Engine, createRegistry } from "@reework/core/internal";
import { testDefinition, tmpStorage } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("pre-v06 storage", () => {
  it("lists v05-shaped records as cases with defaults, and updates survive restart", async () => {
    const storagePath = tmpStorage();
    const engine = await Engine.open({
      storagePath,
      models: createMockModels().models,
      registry: createRegistry(),
    });
    await engine.commit(async (tx) => {
      const doc = await tx.doc(ConversationsDoc);
      doc.conversations.push(
        { id: "legacy-1", key: "one", createdAt: 1000 },
        { id: "legacy-2", key: "two", createdAt: 2000 },
      );
    });
    await engine.close();

    const first = await startTestAgent(testDefinition(), { storagePath });
    running.push(first);
    const cases = await first.agent.host.listCases();
    expect(cases.map((c) => c.id)).toEqual(["legacy-2", "legacy-1"]);
    for (const c of cases) {
      expect(c).toMatchObject({
        status: "open",
        priority: "normal",
        tags: [],
        needsHuman: false,
        openProposals: 0,
      });
      expect(c.updatedAt).toBe(c.createdAt);
    }

    await first.agent.host.updateCase("legacy-1", { stage: "triaged" });
    await first.dispose();

    const restarted = await startTestAgent(testDefinition(), { storagePath });
    running.push(restarted);
    const after = await restarted.agent.host.listCases();
    const updated = after.find((c) => c.id === "legacy-1");
    expect(updated?.stage).toBe("triaged");
    expect(updated?.status).toBe("open");
  });
});
