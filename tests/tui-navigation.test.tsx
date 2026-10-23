// Moving around without memorising commands: lists, the inbox, help, scrolling, input editing.
import { describe, expect, it } from "vitest";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { KEYS, startTui } from "./support/tui.tsx";

const plugin = definePlugin("ops", () => ({
  tools: [
    gatedAction({
      name: "approve",
      gate: { title: "Approve the refund?", options: [{ id: "yes", label: "Approve" }] },
      run: async () => "approved",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "nav-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You help." },
};

describe("TUI navigation", () => {
  it("opens a listed conversation with the arrows and returns with Esc", async () => {
    const tui = await startTui(definition);
    await tui.agent.host.createConversation({ key: "alpha" });
    await tui.agent.host.createConversation({ key: "beta" });
    await tui.waitForFrame("beta");
    await tui.type(KEYS.down, KEYS.enter);
    await tui.waitForFrame("conversation beta");
    await tui.type(KEYS.escape);
    await tui.waitForFrame("reework — inbox");
  });

  it("opens an inbox proposal's conversation with the proposal focused", async () => {
    const tui = await startTui(definition);
    tui.model.respond([toolCall("approve"), text("asked")]);
    const { id } = await tui.agent.host.createConversation({ key: "refunds" });
    await tui.agent.host.submitInput(id, "refund order 7", { wait: true });
    await tui.waitForFrame("Approve the refund?");
    await tui.type(KEYS.enter);
    const frame = await tui.waitForFrame("conversation refunds");
    expect(frame).toMatch(/answer mode/);
  });

  it("lists keys and commands on /help", async () => {
    const tui = await startTui(definition);
    await tui.send("/help");
    const help = await tui.waitForFrame("Keys");
    expect(help).toMatch(/Tab/);
    expect(help).toMatch(/PgUp/);
    expect(help).toMatch(/:i/);
  });

  it("scrolls a long transcript and edits the input line", async () => {
    const tui = await startTui(definition, { rows: 16 });
    const { id } = await tui.agent.host.createConversation({ key: "long" });
    tui.model.respond(Array.from({ length: 12 }, (_, i) => text(`answer number ${i + 1}`)));
    for (let i = 1; i <= 12; i++)
      await tui.agent.host.submitInput(id, `question ${i}`, { wait: true });
    await tui.waitForFrame("long");
    await tui.send(":1");
    const bottom = await tui.waitForFrame("answer number 12");
    expect(bottom).not.toContain("answer number 1\n");

    for (let page = 0; page < 10 && !tui.frame().includes("question 1\n"); page++) {
      await tui.type(KEYS.pageUp);
    }
    const top = await tui.waitForFrame("question 1\n");
    expect(top).not.toContain("answer number 12");
    await tui.type(KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown);
    await tui.waitForFrame("answer number 12");

    tui.model.respond([text("pong")]);
    await tui.type(..."pig".split(""), KEYS.left, "n");
    await tui.waitForFrame(/> ping/);
    await tui.type("x", KEYS.backspace, KEYS.enter);
    await tui.waitForFrame("pong");
    await tui.waitForFrame((f) => !/> ping/.test(f));
    await tui.type(KEYS.up);
    await tui.waitForFrame(/> ping/);
  });

  it("clears a notice after a while", async () => {
    const tui = await startTui(definition, { noticeMs: 300 });
    await tui.send(":9");
    await tui.waitForFrame("no conversation 9");
    await tui.waitForFrame((f) => !f.includes("no conversation 9"), 2000);
  });
});
