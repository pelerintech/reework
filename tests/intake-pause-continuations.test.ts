// A pause holds new intake only: runs in progress and decisions continue, and
// no input path starts new work while paused.
import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, defineTool, gatedAction } from "@reework/core";
import { scriptedModel, waitForIdle, waitForProposal } from "@reework/core/testing";
import {
  authedApp,
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

function slowTool() {
  const waiters: (() => void)[] = [];
  let starts = 0;
  const tool = defineTool({
    name: "slow",
    description: "Takes a while.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      starts += 1;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        waiters.push(resolve);
      });
      return "slow done";
    },
  });
  return {
    tool,
    release: () => {
      for (const waiter of waiters.splice(0)) waiter();
    },
    started: () => starts,
  };
}

function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("what a pause leaves running", () => {
  it("lets a run in progress answer and keeps input submitted during it held", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("run answer"),
      fauxAssistantMessage("held answer"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "run");
    await eventually(() => slow.started() >= 1);
    await agent.pause();
    expect((await agent.status()).activeRuns).toBe(1);
    const held = await agent.host.submitInput(id, "held during run");
    expect(held.held).toBe(true);

    slow.release();
    await waitForIdle(agent.host, id);
    const messages = (await agent.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["run"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["run answer"]);
    expect(await agent.status()).toMatchObject({ paused: true, activeRuns: 0, heldInputs: 1 });
  });

  it("settles a decided gate and continues the case while paused", async () => {
    const decisions: string[] = [];
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
          async run(_ctx, decision) {
            decisions.push(decision.selectedOption ?? "none");
            return "deployed";
          },
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage("deployed done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "deploy it");
    const proposal = await waitForProposal(agent.host, id);
    await agent.pause();
    const held = await agent.host.submitInput(id, "new work while paused");
    expect(held.held).toBe(true);
    expect((await agent.status()).heldInputs).toBe(1);

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await waitForIdle(agent.host, id);
    expect(decisions).toEqual(["go"]);
    const messages = (await agent.host.snapshot(id)).messages;
    const users = messages.filter((m) => m.role === "user").map(textOf);
    expect(users.some((text) => text.includes("[gated action deploy]"))).toBe(true);
    expect(users.some((text) => text.includes('result: "deployed"'))).toBe(true);
    expect(users).not.toContain("new work while paused");
    expect(messages.filter((m) => m.role === "assistant").map(textOf)).toContain("deployed done");
    expect(await agent.status()).toMatchObject({ paused: true, activeRuns: 0, heldInputs: 1 });
  });

  it("holds input from the API route, a plugin and a schedule without starting a run", async () => {
    let conversationId = "";
    let submitFromPlugin: (() => Promise<unknown>) | undefined;
    const plugin = definePlugin("ops", () => ({
      async setup({ host, signal }) {
        const { id } = await host.createConversation();
        conversationId = id;
        submitFromPlugin = () => host.submitInput(id, "via plugin");
        let sent = false;
        const timer = setInterval(() => {
          if (sent || !host.paused) return;
          sent = true;
          clearInterval(timer);
          void host.submitInput(id, "via schedule");
        }, 10);
        signal.addEventListener("abort", () => clearInterval(timer));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: fauxModels().models,
    });
    const { port } = await agent.listen(0);
    await agent.pause();

    const app = authedApp(agent);
    const res = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "via api" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ held: true });

    const pluginResult = (await submitFromPlugin!()) as { held?: boolean };
    expect(pluginResult.held).toBe(true);
    await eventually(async () => (await agent.status()).heldInputs === 3);
    expect(await agent.status()).toMatchObject({ paused: true, activeRuns: 0, heldInputs: 3 });
    expect((await agent.host.snapshot(conversationId)).running).toBe(false);

    await agent.stop();
    untrack(agent);
    void port;
  });

  it("continues an interrupted run across a restart while held input stays held", async () => {
    const storagePath = tmpStorage();
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" })]);
    const first = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      storagePath,
      models: faux.models,
    });
    const { id } = await first.host.createConversation();
    await first.host.submitInput(id, "run");
    await eventually(() => slow.started() >= 1);
    await first.pause();
    await first.host.submitInput(id, "held across restart");
    await first.stop();
    untrack(first);

    const model = scriptedModel("m1");
    model.respond([fauxAssistantMessage("run answer after restart")]);
    const second = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      storagePath,
      models: model.models,
    });
    await eventually(async () => {
      const messages = (await second.host.snapshot(id)).messages;
      return messages.some((m) => m.role === "assistant" && textOf(m).includes("after restart"));
    });
    expect(second.paused).toBe(true);
    expect(await second.status()).toMatchObject({ paused: true, heldInputs: 1 });
    await second.stop();
    untrack(second);
  });
});
