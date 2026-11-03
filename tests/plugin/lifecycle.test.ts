// Plugin lifecycle: a plugin starts background work in `setup` and the agent's
// stop aborts its signal, so the work ends instead of outliving `agent.stop()`.
import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition, PluginStore } from "@reework/core";
import { startTestAgent, waitFor } from "@reework/core/testing";
import { startTestAgent as startTracked, tmpStorage, untrack } from "../support/agent.ts";

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

describe("plugin lifecycle: stop", () => {
  it("stops plugins in reverse order before the engine closes, isolating failures", async () => {
    const order: string[] = [];
    let stoppedStore: PluginStore | undefined;
    const stopPlugin = (name: string, fail = false) =>
      definePlugin(name, () => ({
        setup(ctx) {
          if (name === "c") stoppedStore = ctx.store;
        },
        async stop() {
          if (name === "c") await stoppedStore!.agent.set("stopped", true);
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(name);
          if (fail) throw new Error("boom");
        },
      }));
    const plugins = [
      { plugin: stopPlugin("a"), config: {} },
      { plugin: stopPlugin("b", true), config: {} },
      { plugin: stopPlugin("c"), config: {} },
    ];
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));

    const storagePath = tmpStorage();
    const first = await startTracked(definition(plugins), { storagePath });
    await first.stop();
    untrack(first);

    expect(order).toEqual(["c", "b", "a"]);
    expect(errors.map((args) => args.join(" ")).join("\n")).toContain('plugin "b" stop failed');

    let persisted: unknown;
    const reader = definePlugin("c", () => ({
      async setup(ctx) {
        persisted = await ctx.store.agent.get("stopped");
      },
    }));
    const second = await startTracked(definition([{ plugin: reader, config: {} }]), {
      storagePath,
    });
    await second.stop();
    untrack(second);
    spy.mockRestore();

    expect(persisted).toBe(true);
  });

  it("bounds a hanging plugin stop with the stop timeout and releases the lock", async () => {
    const hang = definePlugin("slow", () => ({
      stop() {
        return new Promise<void>(() => {});
      },
    }));
    const storagePath = tmpStorage();
    const agent = await startTracked(definition([{ plugin: hang, config: {} }]), { storagePath });

    const begun = Date.now();
    await expect(agent.stop({ timeoutMs: 200 })).rejects.toThrow(/plugin "slow" still stopping/);
    expect(Date.now() - begun).toBeLessThan(1_000);
    untrack(agent);

    const next = await startTracked(definition([]), { storagePath });
    await next.stop();
    untrack(next);
  }, 10_000);
});
