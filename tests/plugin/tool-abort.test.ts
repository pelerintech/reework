import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@reework/core";
import { definePlugin, defineTool } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor } from "@reework/core/testing";

const agent = {
  name: "abort",
  model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [],
  channels: [],
  mission: { role: "You are a test agent." },
};

const running: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

/** A tool that waits on `ctx.signal` until it aborts. */
function waitingTool() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  const tool = defineTool({
    name: "hold",
    description: "Holds until aborted.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      started = true;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        void held.then(resolve);
      });
      return "released";
    },
  });
  return { tool, release, started: () => started };
}

describe("abort reaches a running tool through ctx.signal", () => {
  it("aborting the run ends the tool call as an error", async () => {
    const { tool, release, started } = waitingTool();
    const plugin = definePlugin("hold", () => ({ tools: [tool] }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    test.model.respond([toolCall("hold"), text("done")]);
    await test.agent.host.submitInput(id, "hold it");
    await waitFor(() => started());

    await test.agent.host.abort(id);
    await waitFor(async () =>
      JSON.stringify((await test.agent.host.readConversation(id)).entries).includes("aborted"),
    );
    release();
  });

  it("stopping the agent aborts the tool and finishes within its bound", async () => {
    const { tool, started } = waitingTool();
    const plugin = definePlugin("hold", () => ({ tools: [tool] }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin, config: {} }] });
    const { id } = await test.agent.host.createConversation();
    test.model.respond([toolCall("hold"), text("done")]);
    await test.agent.host.submitInput(id, "hold it");
    await waitFor(() => started());

    const t0 = Date.now();
    await test.agent.stop({ timeoutMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
