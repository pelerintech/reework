import { describe, expect, it } from "vitest";

import { createComponentRegistry, installComponents } from "@reework/core/internal";

import type { Component } from "@reework/core/internal";

describe("core module registers as a Component", () => {
  it("registers and discovers a core module via the Component base", async () => {
    const registry = createComponentRegistry();

    let initialized = false;
    const module: Component = {
      id: "audit",
      init: async () => {
        initialized = true;
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installComponents(registry, {} as any, [module]);

    expect(registry.has("audit")).toBe(true);
    expect(registry.get("audit")).toBe(module);
    expect(initialized).toBe(true);
  });
});
