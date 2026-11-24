// A plugin's stop can still commit through a stop-only engine, while progress
// calls are refused during the stop window and reads keep answering.
import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentStopping, definePlugin, defineTool } from "@reework/core";
import type { AgentHost, PluginStore } from "@reework/core";
import { scriptedModel } from "@reework/core/testing";
import {
  authHeaders,
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
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

function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("plugin stops during the stop window", () => {
  it("commits to the plugin store and the commit survives a restart", async () => {
    let store: PluginStore | undefined;
    const flusher = definePlugin("flusher", () => ({
      setup({ store: pluginStore }) {
        store = pluginStore;
      },
      routes(app, ctx) {
        app.get("/stopped", async (c) =>
          c.json({ stopped: (await ctx.store.agent.get<boolean>("stopped")) ?? false }),
        );
      },
      async stop() {
        await store!.agent.set("stopped", true);
      },
    }));
    const storagePath = tmpStorage();
    const first = await startTestAgent(
      testDefinition({ plugins: [{ plugin: flusher, config: {} }] }),
      { storagePath },
    );
    await first.stop();
    untrack(first);

    const second = await startTestAgent(
      testDefinition({ plugins: [{ plugin: flusher, config: {} }] }),
      { storagePath },
    );
    const { port } = await second.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/plugins/flusher/stopped`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    await second.stop();
    untrack(second);
  });

  it("refuses progress calls, answers reads, and starts no work during the stop", async () => {
    const slow = slowTool();
    let conversationId = "";
    let hostRef: AgentHost;
    let refused: unknown;
    let read = false;
    let startedStop!: () => void;
    let releaseStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => (startedStop = resolve));
    const stopRelease = new Promise<void>((resolve) => (releaseStop = resolve));
    const stopper = definePlugin("stopper", () => ({
      async setup({ host }) {
        hostRef = host;
        const { id } = await host.createConversation();
        conversationId = id;
      },
      async stop() {
        try {
          await hostRef.submitInput(conversationId, "during stop");
        } catch (error) {
          refused = error;
        }
        read = (await hostRef.snapshot(conversationId)).conversationId === conversationId;
        startedStop();
        await stopRelease;
      },
    }));
    const ops = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const storagePath = tmpStorage();
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("run done"),
    ]);
    const first = await startTestAgent(
      testDefinition({
        plugins: [
          { plugin: stopper, config: {} },
          { plugin: ops, config: {} },
        ],
      }),
      { storagePath, models: faux.models },
    );
    await first.host.submitInput(conversationId, "run");
    await eventually(() => slow.started() >= 1);

    const stopping = first.stop();
    await stopStarted;
    expect(refused).toBeInstanceOf(AgentStopping);
    expect(read).toBe(true);
    const paused = await first.app.request("/pause", { method: "POST", headers: authHeaders });
    expect(paused.status).toBe(409);
    expect(await paused.json()).toEqual({ error: "agent_stopping" });
    releaseStop();
    await stopping;
    untrack(first);

    const model = scriptedModel("m1");
    model.respond([fauxAssistantMessage("run done")]);
    const second = await startTestAgent(
      testDefinition({ plugins: [{ plugin: ops, config: {} }] }),
      { storagePath, models: model.models },
    );
    await eventually(async () => {
      const messages = (await second.host.snapshot(conversationId)).messages;
      return messages.some((m) => m.role === "assistant" && textOf(m) === "run done");
    });
    const messages = (await second.host.snapshot(conversationId)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["run"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["run done"]);
    await second.stop();
    untrack(second);
  });
});
