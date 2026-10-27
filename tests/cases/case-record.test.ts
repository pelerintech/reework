import { afterEach, describe, expect, it } from "vitest";
import { startTestAgent } from "@reework/core/testing";
import { testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("every conversation is a case", () => {
  it("a new conversation is open, normal, untagged, needsHuman false", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    const c = await test.agent.host.getCase(id);
    expect(c.status).toBe("open");
    expect(c.priority).toBe("normal");
    expect(c.tags).toEqual([]);
    expect(c.needsHuman).toBe(false);
    expect(c.openProposals).toBe(0);
  });

  it("createConversation sets initial case fields and a repeat key is unchanged", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const created = await test.agent.host.createConversation({
      key: "lead-1",
      case: { title: "Acme", priority: "high" },
    });
    const again = await test.agent.host.createConversation({
      key: "lead-1",
      case: { title: "Different", priority: "low" },
    });
    expect(again.created).toBe(false);
    expect(again.id).toBe(created.id);
    const c = await test.agent.host.getCase(created.id);
    expect(c.title).toBe("Acme"); // unchanged on a repeat key
    expect(c.priority).toBe("high");
    expect(c.key).toBe("lead-1");
  });

  it("listCases returns every conversation newest first", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const a = await test.agent.host.createConversation();
    const b = await test.agent.host.createConversation();
    const list = await test.agent.host.listCases();
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
    for (const c of list) {
      expect(c.status).toBe("open");
      expect(c.priority).toBe("normal");
    }
  });
});
