// A proposal is a compact card; its attachments open one at a time in a bounded pane.
import { describe, expect, it } from "vitest";
import { Type, definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { KEYS, startTui } from "./support/tui.tsx";

const diff = [
  "--- a/worker.ts",
  "+++ b/worker.ts",
  ...Array.from({ length: 198 }, (_, i) => `+line ${i + 1}`),
].join("\n");

const plugin = definePlugin("ops", () => ({
  tools: [
    gatedAction({
      name: "patch",
      parameters: Type.Object({}),
      gate: {
        title: "Apply the worker patch?",
        attachments: [
          { kind: "diff", title: "Proposed change", content: diff },
          { kind: "text", title: "Test output", content: "12 passed\n0 failed" },
        ],
        options: [
          { id: "apply", label: "Apply" },
          { id: "skip", label: "Skip" },
        ],
        acceptFreeForm: true,
      },
      run: async () => "applied",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "card-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You patch." },
};

describe("proposal cards", () => {
  it("fold attachments and open one at a time in a bounded, scrollable pane", async () => {
    const tui = await startTui(definition, { rows: 30 });
    tui.model.respond([toolCall("patch"), text("asked")]);
    const { id } = await tui.agent.host.createConversation({ key: "worker" });
    await tui.agent.host.submitInput(id, "fix the worker", { wait: true });
    await tui.waitForFrame(":1 worker");
    await tui.send(":1");

    const card = await tui.waitForFrame(
      (f) => f.includes("conversation worker") && f.includes("Apply the worker patch?"),
    );
    expect(card).toMatch(/Proposed change.*200 lines/);
    expect(card).toMatch(/Test output.*2 lines/);
    expect(card).toContain("Apply");
    expect(card).toContain("Skip");
    expect(card).not.toContain("+line 1\n");
    expect(card).not.toContain("+line 5");

    await tui.type(KEYS.tab, KEYS.right);
    const open = await tui.waitForFrame("+line 5");
    expect(open.split("\n").length).toBeLessThanOrEqual(30);
    expect(open).not.toContain("+line 150");

    for (let page = 0; page < 20 && !tui.frame().includes("+line 150"); page++) {
      await tui.type(KEYS.pageDown);
    }
    const scrolled = await tui.waitForFrame("+line 150");
    expect(scrolled).not.toContain("+line 5\n");

    await tui.type(KEYS.escape);
    const folded = await tui.waitForFrame((f) => !f.includes("+line 150"));
    expect(folded).toMatch(/Proposed change.*200 lines/);
  });
});
