// B14: a stop interrupts in-flight runs before plugin stops, so a tool cut off
// by the stop settles as interrupted on restart and a replay-safe tool re-runs.
import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, defineTool } from "@reework/core";
import { scriptedModel } from "@reework/core/testing";
import {
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

/** A plugin whose tools hold one connection the plugin's `stop()` closes. */
function linkPlugin(calls: string[]) {
  return definePlugin("link", (config: { block: boolean }) => {
    const waiters: ((error: Error) => void)[] = [];
    const connection = {
      fetch: () =>
        config.block
          ? new Promise<string>((_resolve, reject) => waiters.push(reject))
          : Promise.resolve("connected"),
      close: () => {
        for (const reject of waiters.splice(0)) reject(new Error("connection closed"));
      },
    };
    const wait = async (signal: AbortSignal) =>
      Promise.race([
        connection.fetch(),
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
        }),
      ]);
    return {
      tools: [
        defineTool({
          name: "read",
          description: "Read through the link.",
          parameters: Type.Object({}, { additionalProperties: false }),
          replay: "safe",
          async execute(_args, ctx) {
            calls.push("read");
            await wait(ctx.signal);
            return "read ok";
          },
        }),
        defineTool({
          name: "write",
          description: "Write through the link.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_args, ctx) {
            calls.push("write");
            await wait(ctx.signal);
            return "write ok";
          },
        }),
      ],
      stop() {
        connection.close();
      },
    };
  });
}

describe("a stop mid-tool", () => {
  it("interrupts before plugin stops and replays only safe tools", async () => {
    const calls: string[] = [];
    const plugin = linkPlugin(calls);
    const storagePath = tmpStorage();
    const firstModel = fauxModels();
    firstModel.respond([
      fauxAssistantMessage([fauxToolCall("read", {}), fauxToolCall("write", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    // Replace the model catalog with the scripted one before the run starts.
    const firstAgent = await startTestAgent(
      testDefinition({ plugins: [{ plugin, config: { block: true } }] }),
      { storagePath, models: firstModel.models },
    );
    const { id } = await firstAgent.host.createConversation();
    await firstAgent.host.submitInput(id, "read and write");
    await eventually(
      () => calls.filter((c) => c === "read").length === 1 && calls.includes("write"),
    );

    await firstAgent.stop();
    untrack(firstAgent);
    expect(calls.filter((c) => c === "read")).toHaveLength(1);
    expect(calls.filter((c) => c === "write")).toHaveLength(1);

    const model = scriptedModel("m1");
    model.respond([fauxAssistantMessage("done")]);
    const second = await startTestAgent(
      testDefinition({ plugins: [{ plugin, config: { block: false } }] }),
      { storagePath, models: model.models },
    );
    await eventually(async () => {
      const entries = (await second.host.readConversation(id)).entries;
      return JSON.stringify(entries).includes("done");
    });
    expect(calls.filter((c) => c === "read")).toHaveLength(2);
    expect(calls.filter((c) => c === "write")).toHaveLength(1);

    const serialized = JSON.stringify((await second.host.readConversation(id)).entries);
    expect(serialized).toContain("was interrupted");
    expect(serialized).not.toContain("connection closed");
    const messages = (await second.host.snapshot(id)).messages;
    expect(
      messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("done")),
    ).toBe(true);
    await second.stop();
    untrack(second);
  });
});
