import { describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { definePlugin, section, toExtension } from "@reework/core";
import { GreetingPlugin } from "./sample-plugin.js";

describe("the facade turns plugins into pi-durable extensions", () => {
  it("builds a plugin from its config and installs its sections as an extension", () => {
    const counting = definePlugin("counting", (config: { unit: string }) => ({
      sections: [section("counting", () => `Count in ${config.unit}.`, { tag: false })],
    }));

    const registry = createRegistry();
    registry.install(toExtension(GreetingPlugin.name, GreetingPlugin.build(undefined)));
    registry.install(toExtension(counting.name, counting.build({ unit: "apples" })));

    const snapshot = registry.snapshot();
    expect(snapshot.extension("greeting")).toBeDefined();
    expect(snapshot.extension("counting")).toBeDefined();
    expect(snapshot.sections().map((s) => s.section.key)).toEqual(
      expect.arrayContaining(["preamble", "counting"]),
    );
  });
});
