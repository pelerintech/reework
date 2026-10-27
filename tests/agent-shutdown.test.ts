// Stopping an agent cancels its running tools and never hangs; after a clean stop
// mid-tool, a restart picks the conversation up again.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type, defineTool, definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { engineOf } from "@reework/core/internal";
import { scriptedModel, startTestAgent, text, toolCall, waitFor } from "@reework/core/testing";

function agentWith(execute: (signal: AbortSignal | undefined) => Promise<void>): AgentDefinition {
  const plugin = definePlugin("work", () => ({
    tools: [
      defineTool({
        name: "long_job",
        description: "Runs for a long time",
        parameters: Type.Object({}),
        execute: async (_args, ctx) => {
          await execute(ctx.signal);
          return "job done";
        },
      }),
    ],
  }));
  return {
    name: "worker",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You run jobs." },
  };
}

const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });

describe("stopping an agent", () => {
  it("aborts a running tool's signal and stops", async () => {
    let started = false;
    let signal: AbortSignal | undefined;
    const definition = agentWith(async (s) => {
      started = true;
      signal = s;
      await untilAborted(s);
    });
    const { agent, model } = await startTestAgent(definition);
    model.respond([toolCall("long_job"), text("finished")]);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "run the job");
    await waitFor(() => started);

    await agent.stop();
    expect(signal?.aborted).toBe(true);
    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
  });

  it("gives up after its timeout on a tool that ignores the signal, and releases the lock", async () => {
    let started = false;
    let finish!: () => void;
    const stubborn = new Promise<void>((resolve) => (finish = resolve));
    const definition = agentWith(async () => {
      started = true;
      await stubborn;
    });
    const { agent, model } = await startTestAgent(definition);
    model.respond([toolCall("long_job"), text("finished")]);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "run the job");
    await waitFor(() => started);

    const begun = Date.now();
    await expect(agent.stop({ timeoutMs: 500 })).rejects.toThrow(/did not stop within 500 ms/);
    expect(Date.now() - begun).toBeLessThan(1_500);
    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
    finish();
  });

  it("lets a restarted agent finish the conversation a clean stop interrupted", async () => {
    let started = false;
    const definition = agentWith(async (s) => {
      started = true;
      await untilAborted(s);
    });
    const storagePath = join(mkdtempSync(join(tmpdir(), "reework-shutdown-")), "agent.sqlite");
    const first = await startTestAgent(definition, { storagePath });
    first.model.respond([toolCall("long_job")]);
    const { id } = await first.agent.host.createConversation();
    await first.agent.host.submitInput(id, "run the job");
    await waitFor(() => started);
    await first.agent.stop();

    const model = scriptedModel("m1");
    model.respond([text("the job was interrupted; it can be rerun")]);
    const second = await startTestAgent(definition, { storagePath, models: model.models });
    await waitFor(async () =>
      JSON.stringify((await second.agent.host.snapshot(id)).messages).includes("interrupted"),
    );
    await second.dispose();
  });
});
