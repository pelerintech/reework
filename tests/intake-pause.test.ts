// The durable intake hold: pause state on the agent and host, input accepted
// while paused without starting a run, and a resume that runs it in order.
import { describe, expect, it } from "vitest";
import { startTestAgent, testDefinition } from "./support/agent.ts";

describe("the pause state", () => {
  it("is per agent, readable and idempotent", async () => {
    const agent = await startTestAgent(testDefinition());

    expect(agent.paused).toBe(false);
    expect(agent.host.paused).toBe(false);
    expect(await agent.status()).toEqual({ paused: false, activeRuns: 0, heldInputs: 0 });

    const paused = await agent.pause();
    expect(paused.paused).toBe(true);
    expect(typeof paused.pausedAt).toBe("number");
    expect(agent.paused).toBe(true);
    expect(agent.host.paused).toBe(true);
    expect(await agent.status()).toMatchObject({
      paused: true,
      pausedAt: paused.pausedAt,
      activeRuns: 0,
      heldInputs: 0,
    });

    const again = await agent.pause();
    expect(again.pausedAt).toBe(paused.pausedAt);

    const resumed = await agent.resume();
    expect(resumed.paused).toBe(false);
    expect(typeof resumed.resumedAt).toBe("number");
    expect(agent.paused).toBe(false);
    expect(agent.host.paused).toBe(false);

    const twice = await agent.resume();
    expect(twice.resumedAt).toBe(resumed.resumedAt);
    expect(twice.paused).toBe(false);
  });
});
