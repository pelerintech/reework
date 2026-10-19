import { describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { definePlugin, installPlugin, section } from "@reework/core";
import { GreetingPlugin } from "./sample-plugin.js";

describe("Layer-2 facade registers an extension through defineExtension", () => {
  it("defines a plugin against the facade and installs it as a pi-durable extension", () => {
    const plugin = definePlugin({
      name: "counting",
      sections: [section("preamble", () => "Count carefully.", { tag: false })],
    });

    const registry = createRegistry();
    installPlugin(GreetingPlugin, registry);
    registry.install(plugin);

    expect(registry.snapshot().extension("greeting")).toBeDefined();
    expect(registry.snapshot().extension("counting")).toBeDefined();
    expect(
      registry
        .snapshot()
        .sections()
        .map((s) => s.section.key),
    ).toContain("preamble");
  });
});
