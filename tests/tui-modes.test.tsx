// Typing always talks to the agent; answering a proposal happens only with it focused.
import { describe, expect, it } from "vitest";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition, GateDecision } from "@reework/core";
import { text, toolCall, waitFor } from "@reework/core/testing";
import { KEYS, startTui } from "./support/tui.tsx";

function setup(acceptFreeForm: boolean) {
  const decisions: GateDecision[] = [];
  const plugin = definePlugin("ops", () => ({
    tools: [
      gatedAction({
        name: "rollout",
        gate: {
          title: "Roll out v2?",
          options: [
            { id: "now", label: "Roll out now" },
            { id: "later", label: "Wait for tonight" },
          ],
          acceptFreeForm,
        },
        run: async (_ctx, decision) => {
          decisions.push(decision);
          return "noted";
        },
      }),
    ],
  }));
  const definition: AgentDefinition = {
    name: "modes-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You roll out." },
  };
  return { definition, decisions };
}

async function withProposal(acceptFreeForm: boolean) {
  const { definition, decisions } = setup(acceptFreeForm);
  const tui = await startTui(definition);
  tui.model.respond([toolCall("rollout"), text("asked")]);
  const { id } = await tui.agent.host.createConversation({ key: "release" });
  await tui.agent.host.submitInput(id, "ship v2", { wait: true });
  await tui.waitForFrame(":1 release");
  await tui.send(":1");
  await tui.waitForFrame((f) => f.includes("conversation release") && f.includes("Roll out v2?"));
  return { tui, id, decisions };
}

describe("TUI modes", () => {
  it("sends typed text to the agent while a proposal is open", async () => {
    const { tui, id } = await withProposal(true);
    expect(tui.frame()).toMatch(/chat/i);
    tui.model.respond([text("v2 changes the billing schema")]);
    await tui.send("what does v2 change?");
    await tui.waitForFrame("v2 changes the billing schema");
    expect(await tui.agent.host.listProposals({ conversationId: id })).toHaveLength(1);
  });

  it("picks an option with the arrows once the proposal is focused", async () => {
    const { tui, decisions } = await withProposal(true);
    tui.model.respond([text("waiting for tonight")]);
    await tui.type(KEYS.tab);
    await tui.waitForFrame(/answer/i);
    await tui.type(KEYS.down, KEYS.enter);
    await waitFor(() => decisions.length === 1);
    expect(decisions[0]).toMatchObject({ selectedOption: "later", instruction: null });
  });

  it("sends a free-form instruction typed with the proposal focused", async () => {
    const { tui, decisions } = await withProposal(true);
    tui.model.respond([text("will do")]);
    await tui.type(KEYS.tab);
    await tui.send("only to the canary first");
    await waitFor(() => decisions.length === 1);
    expect(decisions[0]).toMatchObject({
      selectedOption: null,
      instruction: "only to the canary first",
    });
  });

  it("says so when the proposal takes no free-form answer", async () => {
    const { tui, decisions } = await withProposal(false);
    await tui.type(KEYS.tab);
    await tui.send("maybe later");
    await tui.waitForFrame(/only .*options/i);
    expect(decisions).toEqual([]);
  });
});
