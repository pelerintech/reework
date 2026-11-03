// Plugin lifecycle: a plugin starts background work in `setup` and the agent's
// stop aborts its signal, so the work ends instead of outliving `agent.stop()`.
import { describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, waitFor } from "@reework/core/testing";

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "ticker-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You tick." },
  };
}

describe("plugin lifecycle: setup signal", () => {
  it("aborts the setup signal when the agent stops, ending the loop", async () => {
    let ticks = 0;
    let seen: AbortSignal | undefined;
    const ticker = definePlugin("ticker", () => ({
      setup({ signal }) {
        seen = signal;
        const timer = setInterval(() => {
          ticks += 1;
        }, 10);
        signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      },
    }));

    const test = await startTestAgent(definition([{ plugin: ticker, config: {} }]));
    await waitFor(() => ticks >= 2);
    await test.dispose();

    expect(seen?.aborted).toBe(true);
    const atStop = ticks;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ticks).toBe(atStop);
  });
});
