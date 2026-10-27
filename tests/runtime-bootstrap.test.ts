import { describe, expect, it } from "vitest";
import { startTestAgent, testDefinition, untrack } from "./support/agent.ts";
import { engineOf } from "@reework/core/internal";

describe("startAgent boots an agent from a definition", () => {
  it("serves health from its app", async () => {
    const running = await startTestAgent(testDefinition());
    const health = await running.app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, name: "test-agent" });
  });

  it("stop() closes the engine and shuts down cleanly", async () => {
    const running = await startTestAgent(testDefinition());
    untrack(running);
    await expect(running.stop()).resolves.toBeUndefined();
    // After stop, the engine is closed (a subsequent commit rejects).
    await expect(engineOf(running).commit(() => ({}))).rejects.toBeTruthy();
  });
});
