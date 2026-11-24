// Plugins read the intake state synchronously or authoritatively, and get one
// agent-level event per pause or resume through the FIFO event queue.
import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentStatus } from "@reework/types";
import { definePlugin, defineTool } from "@reework/core";
import type { PluginEventContext } from "@reework/core";
import { waitFor, waitForIdle } from "@reework/core/testing";
import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

function slowTool() {
  const waiters: (() => void)[] = [];
  const tool = defineTool({
    name: "slow",
    description: "Takes a while.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        waiters.push(resolve);
      });
      return "slow done";
    },
  });
  return {
    tool,
    release: () => {
      for (const waiter of waiters.splice(0)) waiter();
    },
    started: () => waiters.length,
  };
}

describe("plugins and the agent state", () => {
  it("reads the state in setup and gets one event per transition", async () => {
    const calls: { state: AgentStatus; ctx: PluginEventContext }[] = [];
    let setup: { paused: boolean; status: AgentStatus } | undefined;
    const watcher = definePlugin("watcher", () => ({
      async setup({ host }) {
        setup = { paused: host.paused, status: await host.status() };
      },
      hooks: {
        async onAgentState(state, ctx) {
          calls.push({ state, ctx });
          await ctx.store.agent.set("last", state.paused);
        },
      },
    }));
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin: watcher, config: {} }] }),
    );
    expect(setup).toMatchObject({ paused: false, status: { paused: false } });

    const paused = await agent.pause();
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.state).toMatchObject({ paused: true, pausedAt: paused.pausedAt });
    expect(calls[0]!.ctx).not.toHaveProperty("conversationId");
    expect(calls[0]!.ctx.case).toBeUndefined();
    expect(calls[0]!.ctx.store.case).toBeUndefined();
    expect(await calls[0]!.ctx.store.agent.get("last")).toBe(true);

    await agent.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);

    const resumed = await agent.resume();
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.state).toMatchObject({ paused: false, resumedAt: resumed.resumedAt });
    expect(await calls[1]!.ctx.store.agent.get("last")).toBe(false);
  });

  it("logs a throwing hook and still pauses", async () => {
    const calls: AgentStatus[] = [];
    const thrower = definePlugin("thrower", () => ({
      hooks: {
        async onAgentState() {
          throw new Error("boom");
        },
      },
    }));
    const watcher = definePlugin("watcher", () => ({
      hooks: {
        async onAgentState(state) {
          calls.push(state);
        },
      },
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = await startTestAgent(
        testDefinition({
          plugins: [
            { plugin: thrower, config: {} },
            { plugin: watcher, config: {} },
          ],
        }),
      );
      await agent.pause();
      expect(agent.paused).toBe(true);
      await waitFor(() => calls.length === 1);
      expect(calls[0]!.paused).toBe(true);
      expect(
        error.mock.calls.some((call) =>
          String(call[0]).includes('plugin "thrower" onAgentState hook threw'),
        ),
      ).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("delivers nothing for a run ending while paused", async () => {
    const slow = slowTool();
    const calls: AgentStatus[] = [];
    const watcher = definePlugin("watcher", () => ({
      tools: [slow.tool],
      hooks: {
        async onAgentState(state) {
          calls.push(state);
        },
      },
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("slow done"),
    ]);
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin: watcher, config: {} }] }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "run");
    await eventually(() => slow.started() >= 1);
    await agent.pause();
    await waitFor(() => calls.length === 1);
    slow.release();
    await waitForIdle(agent.host, id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
  });
});
