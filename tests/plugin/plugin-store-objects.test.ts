import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";

const running: TestAgent[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((agent) => agent.dispose()));
});

function definition(extra?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "store-objects",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "conv" },
    plugins: [],
    channels: [],
    mission: { role: "r" },
    ...extra,
  };
}

const schedule = {
  id: "digest",
  next: 1_700_000_000_000,
  target: { kind: "new" },
  tags: ["a", "b"],
};

describe("plugin store with structured values", () => {
  it("returns objects that stay readable after the call returned", async () => {
    const kept: { got?: unknown; listed?: unknown[]; updated?: unknown } = {};
    const keeper = definePlugin("keeper", () => ({
      async setup(ctx) {
        await ctx.store.agent.set("schedule/digest", schedule);
        await ctx.store.agent.set("schedule/other", { ...schedule, id: "other" });
      },
      routes(app, ctx) {
        app.get("/read", async (c) => {
          kept.got = (await ctx.store.agent.get("schedule/digest")) ?? null;
          kept.listed = (await ctx.store.agent.list("schedule/")).map((item) => item.value);
          await ctx.store.agent.update("schedule/digest", (current) => {
            const state = current as typeof schedule;
            return { ...state, next: state.next + 60_000, tags: [...state.tags, "c"] };
          });
          kept.updated = (await ctx.store.agent.get("schedule/digest")) ?? null;
          return c.json({ ok: true });
        });
      },
    }));
    const test = await startTestAgent(definition({ plugins: [{ plugin: keeper, config: {} }] }));
    running.push(test);

    const response = await test.agent.app.request("/plugins/keeper/read", {
      headers: { authorization: `Bearer ${test.token}` },
    });
    expect(response.status).toBe(200);

    // Read long after each store call returned: nested fields and arrays are plain data.
    expect(kept.got).toEqual(schedule);
    expect((kept.got as typeof schedule).target.kind).toBe("new");
    expect(kept.listed).toEqual([schedule, { ...schedule, id: "other" }]);
    expect(kept.updated).toEqual({
      ...schedule,
      next: schedule.next + 60_000,
      tags: ["a", "b", "c"],
    });
    expect(JSON.parse(JSON.stringify(kept))).toEqual(kept);
  });

  it("returns case-scope objects readable after the tool's store call", async () => {
    let seen: unknown;
    let output = "";
    const remember = definePlugin("remember", () => ({
      tools: [
        defineTool({
          name: "remember",
          description: "keep a record",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            await ctx.store.case.set("taint", {
              tainted: true,
              source: "input from system:alerts",
            });
            seen = await ctx.store.case.get("taint");
            const record = seen as { tainted: boolean; source: string };
            output = `${record.tainted}:${record.source}`;
            return output;
          },
        }),
      ],
    }));
    const test = await startTestAgent(definition({ plugins: [{ plugin: remember, config: {} }] }));
    running.push(test);
    test.model.respond([toolCall("remember", {}), text("done")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen).toEqual({ tainted: true, source: "input from system:alerts" });
    expect(output).toBe("true:input from system:alerts");
  });
});
