import { describe, expect, it } from "vitest";

import { createComponentRegistry, installComponents } from "@reework/core/internal";

import type { Component } from "@reework/core/internal";

// A Channel-style domain contract extends the common Component base with its own surface.
interface ChannelComponent extends Component {
  readonly domain: "channel";
  readonly send: (message: string) => Promise<string>;
}

describe("Component base extends into a domain-specific contract", () => {
  it("lets a Channel-style contract add its own surface while sharing the base lifecycle", async () => {
    const registry = createComponentRegistry();

    let disposed = false;
    const web: ChannelComponent = {
      id: "web",
      domain: "channel",
      dispose: async () => {
        disposed = true;
      },
      send: async (message: string) => `echo: ${message}`,
    };

    await installComponents(registry, {} as never, [web]);

    expect(registry.has("web")).toBe(true);
    const found = registry.get<ChannelComponent>("web");
    expect(found?.domain).toBe("channel");
    expect(await found?.send("hi")).toBe("echo: hi");
    await found?.dispose?.();
    expect(disposed).toBe(true);
  });
});
