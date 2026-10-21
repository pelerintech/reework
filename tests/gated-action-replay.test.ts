import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, gatedAction, listOpenProposals } from "@reework/core";
import type { RunningAgent } from "@reework/core";
import {
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

const act = () => gatedAction({ name: "act", gate: { title: "Act?" }, run: async () => "acted" });

/** A model that calls `act`, and calls it again whenever the last call did not succeed. */
const retryingModel: FauxResponseStep = (context) => {
  const last = context.messages.at(-1) as { role?: string; isError?: boolean } | undefined;
  if (last?.role === "toolResult" && !last.isError)
    return fauxAssistantMessage("waiting for approval");
  return fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" });
};

describe("a gated-action call interrupted after it opened its gate", () => {
  it("leaves exactly one proposal after restart", async () => {
    const storagePath = tmpStorage();
    let first!: RunningAgent;
    let crashed = false;

    // Agent 1: the tool commits its proposal, then the process "dies" before the call returns.
    const crashing = definePlugin("gated", () => {
      const tool = act();
      return {
        tools: [
          {
            ...tool,
            async execute(args, api, context) {
              await tool.execute(args, api, context);
              crashed = true;
              void first.stop();
              return new Promise((_resolve, reject) => {
                context.abortSignal?.addEventListener("abort", () => reject(new Error("crashed")));
              });
            },
          } as typeof tool,
        ],
      };
    });
    const faux1 = fauxModels();
    faux1.respond([retryingModel]);
    first = await startTestAgent(testDefinition({ plugins: [{ plugin: crashing, config: {} }] }), {
      storagePath,
      models: faux1.models,
    });
    untrack(first);
    const { id } = await first.host.createConversation();
    await first.host.submitInput(id, "do the thing");
    await eventually(() => crashed);
    await eventually(async () => {
      try {
        await first.engine.commit(() => ({}));
        return false;
      } catch {
        return true;
      }
    });

    // Agent 2: same storage, same plugin (without the crash), a model that retries failures.
    const plugin = definePlugin("gated", () => ({ tools: [act()] }));
    const faux2 = fauxModels();
    faux2.respond([retryingModel, retryingModel, retryingModel]);
    const second = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      storagePath,
      models: faux2.models,
    });

    await eventually(async () =>
      JSON.stringify(await second.host.readConversation(id)).includes("waiting for approval"),
    );
    expect(await listOpenProposals(second.engine)).toHaveLength(1);
  }, 20_000);
});
