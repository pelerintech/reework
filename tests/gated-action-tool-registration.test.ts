import { describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { definePlugin, gatedAction, installPlugin } from "@reework/core";

describe("a gated-action tool registers as a callable tool via the facade", () => {
  it("is installed into a registry and offered as a callable tool by name", () => {
    const applyRollback = gatedAction({
      name: "apply.rollback",
      gate: {
        title: "Apply rollback?",
        options: [{ id: "rollback", label: "Roll back" }],
        acceptFreeForm: true,
      },
      async run(_ctx, _decision) {
        return "rolled back";
      },
    });

    const registry = createRegistry();
    installPlugin(definePlugin({ name: "gated", tools: [applyRollback] }), registry);

    const tools = registry
      .snapshot()
      .tools()
      .map((entry) => entry.tool.name);
    expect(tools).toContain("apply.rollback");
  });
});
