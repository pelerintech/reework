import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { CONTEXT, Engine, toExtension } from "@reework/core";
import { ENGINE_TEST_MODELS } from "../durable/model-setup.js";
import { GreetingPlugin } from "./sample-plugin.js";

const open: Engine[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

afterEach(async () => {
  while (open.length > 0) {
    const engine = open.pop()!;
    await engine.close();
  }
});

describe("facade shields the plugin from pi-durable API changes", () => {
  it("a plugin defined only against the facade installs and runs unchanged", async () => {
    // The plugin module (sample-plugin.ts) imports ONLY `@reework/core` (the
    // facade) — never `@earendil-works/pi-durable` — so a change in pi-durable's
    // extension API is contained in the facade, not the plugin.
    const registry = createRegistry();
    registry.install(toExtension(GreetingPlugin.name, GreetingPlugin.build(undefined)));

    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("Hello there!")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models, registry });
    open.push(engine);

    // The plugin's section is live in the resolved agent.
    const root = await engine.root();
    const agent = await root.agent(CONTEXT);
    expect(agent.sections.some((s) => s.key === "preamble")).toBe(true);

    // And the plugin's presence does not break a real run.
    const answer = await engine.run("Hi");
    expect(answer).toContain("Hello");
  });
});
