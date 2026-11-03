// Case lifecycle hooks: a plugin learns when a case closes and when a closed case
// reopens, once per transition, in the order the events happen.
import { describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every event hook the recorder saw, in delivery order. */
let log: string[] = [];

function definition(): AgentDefinition {
  const recorder = definePlugin("recorder", () => ({
    hooks: {
      async onInput(input) {
        log.push(`input:${input.content}`);
      },
      async onCaseClosed({ case: closed }) {
        log.push(`closed:${closed.status}`);
      },
      async onCaseReopened({ case: reopened, cause }) {
        log.push(`reopened:${cause}:${reopened.status}`);
      },
    },
    tools: [
      defineTool({
        name: "cycle",
        description: "Close the case, reopen it to open, close it, then reopen it to waiting.",
        parameters: Type.Object({}),
        async execute(_args, ctx) {
          await ctx.case.update({ status: "closed" });
          await ctx.case.update({ status: "open" });
          await ctx.case.update({ status: "closed" });
          await ctx.case.update({ status: "waiting" });
          return "cycled";
        },
      }),
    ],
  }));
  return {
    name: "case-hooks",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin: recorder, config: {} }],
    channels: [],
    mission: { role: "You work cases." },
  };
}

describe("case lifecycle event hooks", () => {
  it("fires once per transition, in order, from every write path", async () => {
    log = [];
    const test = await startTestAgent(definition());
    const { id } = await test.agent.host.createConversation();
    const closeOverHttp = () =>
      test.agent.app.request(`/conversations/${id}/case`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${test.token}`,
        },
        body: JSON.stringify({ status: "closed" }),
      });
    const closes = () => log.filter((entry) => entry === "closed:closed").length;

    await closeOverHttp();
    await eventually(() => closes() === 1);
    await closeOverHttp();
    await sleep(100);
    expect(closes()).toBe(1);

    test.model.respond([text("hello back")]);
    await test.agent.host.submitInput(id, "hello");
    await eventually(() => log.includes("input:hello"));
    expect(log.slice(-2)).toEqual(["reopened:input:open", "input:hello"]);

    test.model.respond([toolCall("update_case", { status: "closed" }), text("closed it")]);
    await test.agent.host.submitInput(id, "close it", { wait: true });
    await eventually(() => closes() === 2);
    // The input that caused the close is delivered before the close itself.
    expect(log.slice(-2)).toEqual(["input:close it", "closed:closed"]);

    test.model.respond([toolCall("cycle"), text("cycled it")]);
    await test.agent.host.submitInput(id, "cycle it", { wait: true });
    await eventually(() => log.includes("reopened:update:waiting"));
    expect(closes()).toBe(4);
    expect(log.slice(-5)).toEqual([
      "input:cycle it",
      "closed:closed",
      "reopened:update:open",
      "closed:closed",
      "reopened:update:waiting",
    ]);

    await closeOverHttp();
    await eventually(() => closes() === 5);
    await test.dispose();
  }, 20_000);
});
