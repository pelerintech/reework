import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import { testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("updating cases (host + plugin)", () => {
  it("host.updateCase stores fields, moves updatedAt, and validates patches", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    const before = await test.agent.host.getCase(id);
    const updated = await test.agent.host.updateCase(id, {
      stage: "triaged",
      tags: ["lead"],
      dueAt: 1_700_000_000_000,
    });
    expect(updated.stage).toBe("triaged");
    expect(updated.tags).toEqual(["lead"]);
    expect(updated.dueAt).toBe(1_700_000_000_000);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    // Invalid patches are refused naming the field.
    await expect(test.agent.host.updateCase(id, { nope: 1 } as never)).rejects.toThrow(/nope/);
    await expect(
      test.agent.host.updateCase(id, { stage: "x".repeat(65) } as never),
    ).rejects.toThrow(/stage/);
    await expect(
      test.agent.host.updateCase(id, { tags: Array.from({ length: 17 }, () => "t") } as never),
    ).rejects.toThrow(/tags/);
    await expect(test.agent.host.updateCase(id, { dueAt: "tomorrow" } as never)).rejects.toThrow(
      /dueAt/,
    );
    await expect(test.agent.host.updateCase(id, { status: "bogus" } as never)).rejects.toThrow(
      /status/,
    );
  });

  it("ctx.case.update from a tool updates the same case", async () => {
    const setStage = definePlugin("setstage", () => ({
      tools: [
        defineTool({
          name: "setstage",
          description: "set",
          parameters: Type.Object({ stage: Type.String() }),
          async execute(args, ctx) {
            const c = await ctx.case.update({ stage: args.stage });
            return `stage=${c.stage}`;
          },
        }),
      ],
    }));
    const def: AgentDefinition = {
      ...testDefinition(),
      plugins: [{ plugin: setStage, config: {} }],
    };
    const test = await startTestAgent(def);
    running.push(test);
    test.model.respond([toolCall("setstage", { stage: "analyzing" }), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go", { wait: true });
    const c = await test.agent.host.getCase(id);
    expect(c.stage).toBe("analyzing");
  });

  it("the snapshot carries the case", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    const snap = await test.agent.host.snapshot(id);
    expect(snap.case).toMatchObject({ status: "open", priority: "normal", needsHuman: false });
    expect(snap.case.id).toBe(id);
  });

  it("input moves updatedAt for open and waiting cases", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    test.model.respond([text("one"), text("two")]);
    const open = await test.agent.host.createConversation({ key: "open-input" });
    const waiting = await test.agent.host.createConversation({ key: "waiting-input" });
    await test.agent.host.updateCase(waiting.id, { status: "waiting" });
    const beforeOpen = await test.agent.host.getCase(open.id);
    const beforeWaiting = await test.agent.host.getCase(waiting.id);

    await test.agent.host.submitInput(open.id, "hello", { wait: true });
    const res = await test.agent.app.request(`/conversations/${waiting.id}/messages?wait=true`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${test.token}`,
      },
    });
    expect(res.status).toBe(200);

    const afterOpen = await test.agent.host.getCase(open.id);
    const afterWaiting = await test.agent.host.getCase(waiting.id);
    expect(afterOpen.updatedAt).toBeGreaterThan(beforeOpen.updatedAt);
    expect(afterWaiting.updatedAt).toBeGreaterThan(beforeWaiting.updatedAt);
    expect(afterWaiting.status).toBe("waiting");
  });
});
