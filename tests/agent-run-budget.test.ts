// `limits.toolRoundsPerRun` stops a model that keeps calling tools: past the budget
// its calls are refused with guidance, and it answers with what it has.
import { describe, expect, it } from "vitest";
import { Type, defineTool, definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall, toolCalls, waitForIdle } from "@reework/core/testing";

function setup(limits?: AgentDefinition["limits"]) {
  const executed: string[] = [];
  const plugin = definePlugin("work", () => ({
    tools: [
      defineTool({
        name: "step",
        description: "One step",
        parameters: Type.Object({}),
        execute: async () => {
          executed.push("step");
          return "stepped";
        },
      }),
      gatedAction({
        name: "deploy",
        gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
        run: async () => "deployed",
      }),
    ],
  }));
  const definition: AgentDefinition = {
    name: "budgeted",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You work in steps." },
    ...(limits ? { limits } : {}),
  };
  return { definition, executed };
}

async function transcript(agent: Awaited<ReturnType<typeof startTestAgent>>["agent"], id: string) {
  return (await agent.host.snapshot(id)).transcript;
}

describe("the run budget", () => {
  it("refuses tool rounds past the budget and lets the model answer", async () => {
    const { definition, executed } = setup({ toolRoundsPerRun: 2 });
    const { agent, model, dispose } = await startTestAgent(definition);
    model.respond([
      toolCalls([["step"], ["step"]]), // one round, two calls
      toolCall("step"),
      toolCall("step"), // third round: refused
      text("stopping here: two rounds done"),
    ]);
    const { id } = await agent.host.createConversation();
    const { message } = await agent.host.submitInput(id, "work", { wait: true });

    expect(executed).toEqual(["step", "step", "step"]);
    expect(JSON.stringify(message)).toContain("stopping here");
    const tools = (await transcript(agent, id)).filter((i) => i.type === "tool");
    expect(tools.map((t) => t.type === "tool" && t.status)).toEqual([
      "done",
      "done",
      "done",
      "error",
    ]);
    const { entries } = await agent.host.readConversation(id);
    expect(JSON.stringify(entries.at(-2))).toContain("budget");
    await dispose();
  });

  it("aborts a run whose model keeps calling tools after a refusal; the conversation stays usable", async () => {
    const { definition } = setup({ toolRoundsPerRun: 1 });
    const { agent, model, dispose } = await startTestAgent(definition);
    model.respond([toolCall("step"), toolCall("step"), toolCall("step"), toolCall("step")]);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "work");
    await waitForIdle(agent.host, id, { timeoutMs: 5000 });
    const rounds = (await agent.host.readConversation(id)).entries.filter(
      (e) => e.kind === "pi.assistant",
    );
    expect(rounds).toHaveLength(3); // allowed, refused, refused again → aborted; no fourth

    model.respond([text("fresh start")]);
    const { message } = await agent.host.submitInput(id, "again", { wait: true });
    expect(JSON.stringify(message)).toContain("fresh start");
    await dispose();
  });

  it("gives each new input a fresh budget", async () => {
    const { definition, executed } = setup({ toolRoundsPerRun: 1 });
    const { agent, model, dispose } = await startTestAgent(definition);
    model.respond([toolCall("step"), text("one"), toolCall("step"), text("two")]);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "first", { wait: true });
    await agent.host.submitInput(id, "second", { wait: true });
    expect(executed).toEqual(["step", "step"]);
    await dispose();
  });

  it("opens no proposal for a gated action past the budget", async () => {
    const { definition } = setup({ toolRoundsPerRun: 1 });
    const { agent, model, dispose } = await startTestAgent(definition);
    model.respond([toolCall("step"), toolCall("deploy"), text("could not deploy")]);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });
    expect(await agent.host.listProposals()).toEqual([]);
    await dispose();
  });

  it("does not limit tool rounds without a budget", async () => {
    const { definition, executed } = setup();
    const { agent, model, dispose } = await startTestAgent(definition);
    model.respond([
      toolCall("step"),
      toolCall("step"),
      toolCall("step"),
      toolCall("step"),
      text("done"),
    ]);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });
    expect(executed).toHaveLength(4);
    await dispose();
  });
});
