// Case owners: the principal a case's notifications go to. Settable at creation
// and by a patch, visible in the tool context, snapshots and event hooks, and
// validated like every other author.
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, InvalidAuthor, Type } from "@reework/core";
import type { Author, Case } from "@reework/types";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";
import { testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("case owners", () => {
  it("shows the owner set at creation in the tool context, snapshot and event hook", async () => {
    const owner: Author = { kind: "human", id: "slack:U1", name: "Ana" };
    const seen: Case[] = [];
    const closed: Case[] = [];
    const reader = definePlugin("reader", () => ({
      tools: [
        defineTool({
          name: "read_case",
          description: "Reads the conversation's case.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_args, ctx) {
            seen.push(await ctx.case.get());
            return "read";
          },
        }),
      ],
    }));
    const watcher = definePlugin("watcher", () => ({
      hooks: {
        async onCaseClosed({ case: c }) {
          closed.push(c);
        },
      },
    }));
    const test = await startTestAgent(
      testDefinition({
        plugins: [
          { plugin: reader, config: {} },
          { plugin: watcher, config: {} },
        ],
      }),
    );
    running.push(test);

    const { id } = await test.agent.host.createConversation({
      key: "owned",
      case: { owner },
    });
    test.model.respond([toolCall("read_case"), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen[0]?.owner).toEqual(owner);
    expect((await test.agent.host.snapshot(id)).case.owner).toEqual(owner);

    await test.agent.host.updateCase(id, { status: "closed" });
    const eventCase = await eventually(() => closed[0]);
    expect(eventCase.owner).toEqual(owner);
  });

  it("changes the owner by patch and rejects an invalid author", async () => {
    const test = await startTestAgent(testDefinition());
    running.push(test);
    const { id } = await test.agent.host.createConversation({
      key: "owned",
      case: { owner: { kind: "human", id: "slack:U1" } },
    });

    const next: Author = { kind: "agent", id: "agent:orchestrator" };
    expect((await test.agent.host.updateCase(id, { owner: next })).owner).toEqual(next);
    expect((await test.agent.host.getCase(id)).owner).toEqual(next);

    await expect(
      test.agent.host.updateCase(id, { owner: { kind: "boss" } as unknown as Author }),
    ).rejects.toBeInstanceOf(InvalidAuthor);

    const res = await test.agent.app.request(`/conversations/${id}/case`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${test.token}`,
      },
      body: JSON.stringify({ owner: { kind: "boss" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_author");
    expect((await test.agent.host.getCase(id)).owner).toEqual(next);
  });
});
