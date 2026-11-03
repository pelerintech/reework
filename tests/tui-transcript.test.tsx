// Attaching to a conversation shows its history; a streamed answer reads as one message.
import { describe, expect, it } from "vitest";
import { Type, defineTool, definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { startTui } from "./support/tui.tsx";

const plugin = definePlugin("ops", () => ({
  tools: [
    defineTool({
      name: "lookup",
      description: "Look it up",
      parameters: Type.Object({}),
      execute: async () => "found",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "tui-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You answer." },
};

describe("the TUI transcript", () => {
  it("shows the earlier exchange and its tool call when attaching", async () => {
    const tui = await startTui(definition);
    tui.model.respond([toolCall("lookup"), text("Here is what I found.")]);
    const { id } = await tui.agent.host.createConversation({ key: "billing" });
    await tui.agent.host.submitInput(id, "what is up with billing?", { wait: true });

    await tui.waitForFrame("billing");
    await tui.send(":1");
    const frame = await tui.waitForFrame("Here is what I found.");
    expect(frame).toContain("what is up with billing?");
    expect(frame).toMatch(/lookup/);
    const order = ["what is up with billing?", "lookup", "Here is what I found."].map((s) =>
      frame.indexOf(s),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("assembles a streamed answer into one block", async () => {
    const tui = await startTui(definition);
    const { id } = await tui.agent.host.createConversation({ key: "stream" });
    await tui.waitForFrame("stream");
    await tui.send(":1");
    await tui.waitForFrame("conversation stream");
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    tui.model.respond([text(words)]);
    await tui.send("tell me");
    const frame = await tui.waitForFrame("w29");
    expect(frame.replace(/\s+/g, " ")).toContain(words);
    expect(frame.match(/agent:/g)).toHaveLength(1);
    expect(id).toBeTruthy();
  });

  it("sends the operator's message as a human", async () => {
    const tui = await startTui(definition);
    const { id } = await tui.agent.host.createConversation({ key: "human" });
    await tui.waitForFrame("human");
    await tui.send(":1");
    tui.model.respond([text("hello back")]);
    await tui.send("hi there");
    await tui.waitForFrame("hello back");

    const read = await tui.agent.host.readConversation(id);
    const entry = read.entries.find((e) => e.kind === "reework.input");
    expect((entry?.data as { from?: { kind?: string } } | undefined)?.from?.kind).toBe("human");
  });
});
