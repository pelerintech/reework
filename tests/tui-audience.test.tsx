// A proposal card names who may decide it, so the operator sees whether a gate
// admits an agent decider before answering.
import { describe, expect, it } from "vitest";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { startTui } from "./support/tui.tsx";

const plugin = definePlugin("ops", () => ({
  tools: [
    gatedAction({
      name: "deploy",
      gate: { title: "Deploy?", options: [{ id: "go", label: "Go" }] },
      run: async () => "deployed",
    }),
    gatedAction({
      name: "approve",
      audience: "human-or-agent",
      gate: { title: "Approve?", options: [{ id: "yes", label: "Yes" }] },
      run: async () => "approved",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "audience-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You deploy and approve." },
};

describe("proposal card audiences", () => {
  it("shows a human gate as humans only and an agent-capable gate as humans or agents", async () => {
    const tui = await startTui(definition);
    tui.model.respond([toolCall("deploy"), text("asked")]);
    const { id } = await tui.agent.host.createConversation({ key: "worker" });
    await tui.agent.host.submitInput(id, "deploy it", { wait: true });
    await tui.send(":1");

    const humanCard = await tui.waitForFrame(
      (frame) => frame.includes("Deploy?") && frame.includes("humans only"),
    );
    expect(humanCard).not.toContain("humans or agents");

    tui.model.append([toolCall("approve"), text("asked")]);
    await tui.agent.host.submitInput(id, "approve it", { wait: true });

    const cards = await tui.waitForFrame(
      (frame) => frame.includes("Approve?") && frame.includes("humans or agents"),
    );
    expect(cards).toContain("humans only");
    expect(cards).toContain("humans or agents");
  });
});
