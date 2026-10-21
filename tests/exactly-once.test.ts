import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc } from "@earendil-works/pi-durable";
import { CONTEXT, definePlugin, defineTool, once, onceInCommit } from "@reework/core";
import type { RunningAgent } from "@reework/core";
import {
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

const Counter = defineDoc<{ n: number }>({
  kind: "test.counter",
  version: 1,
  scope: "session",
  initial: () => ({ n: 0 }),
});

describe("exactly-once helpers for replay-safe plugin tools", () => {
  it("runs a tool's effects once even when the call reruns after a crash", async () => {
    const storagePath = tmpStorage();
    const pushes: string[] = [];
    let crashing = true;
    let crashed = false;
    let agent!: RunningAgent;

    const plugin = definePlugin("deploy", () => ({
      tools: [
        defineTool({
          name: "push",
          description: "Push the branch.",
          parameters: Type.Object({}, { additionalProperties: false }),
          replay: "safe",
          async execute(_args, api, context) {
            const pushed = await once(api, "push", context, async () => {
              pushes.push("oncall/42");
              return "pushed oncall/42";
            });
            await onceInCommit(api, context, async (tx) => {
              (await tx.doc(Counter)).n += 1;
              return true;
            });
            if (crashing) {
              crashed = true;
              void agent.stop();
              return new Promise((_resolve, reject) => {
                context.abortSignal?.addEventListener("abort", () => reject(new Error("crashed")));
              });
            }
            return { output: [{ type: "text", text: pushed }] };
          },
        }),
      ],
    }));
    const start = (steps: Parameters<ReturnType<typeof fauxModels>["respond"]>[0]) => {
      const faux = fauxModels();
      faux.respond(steps);
      return startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
        storagePath,
        models: faux.models,
      });
    };

    agent = await start([
      fauxAssistantMessage([fauxToolCall("push", {})], { stopReason: "toolUse" }),
    ]);
    untrack(agent);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "push it");
    await eventually(() => crashed);
    await eventually(async () =>
      agent.engine
        .commit(() => ({}))
        .then(
          () => false,
          () => true,
        ),
    );

    crashing = false;
    const second = await start([fauxAssistantMessage("pushed")]);
    await eventually(async () =>
      JSON.stringify(await second.host.readConversation(id)).includes("pushed oncall/42"),
    );
    expect(pushes).toEqual(["oncall/42"]);
    expect((await second.engine.harness.snapshot(Counter, CONTEXT))?.n).toBe(1);
  }, 20_000);
});
