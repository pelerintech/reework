import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc } from "@earendil-works/pi-durable";
import { definePlugin, defineTool } from "@reework/core";
import { CONTEXT, onceInCommit, toolInternal, engineOf } from "@reework/core/internal";

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
          async execute(_args, ctx) {
            const { api, context } = toolInternal(ctx);
            const pushed = await ctx.once("push", async () => {
              pushes.push("effect/42");
              return "pushed effect/42";
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
            return pushed;
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
      engineOf(agent)
        .commit(() => ({}))
        .then(
          () => false,
          () => true,
        ),
    );

    crashing = false;
    const second = await start([fauxAssistantMessage("pushed")]);
    await eventually(async () =>
      JSON.stringify(await second.host.readConversation(id)).includes("pushed effect/42"),
    );
    expect(pushes).toEqual(["effect/42"]);
    expect((await engineOf(second).harness.snapshot(Counter, CONTEXT))?.n).toBe(1);
  }, 20_000);
});
