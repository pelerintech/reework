import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@reework/core";
import { definePlugin, defineTool, gatedAction } from "@reework/core";
import type { ToolContext } from "@reework/core";
import {
  startTestAgent,
  text,
  toolCall,
  waitFor,
  waitForIdle,
  waitForProposal,
} from "@reework/core/testing";

const agent = {
  name: "gatedctx",
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

describe("gated actions get the reework context", () => {
  it("gives gate and run the conversation id, the scoped members, and run a signal", async () => {
    let gateCtx: Record<string, unknown> | undefined;
    let runCtx: Record<string, unknown> | undefined;
    const action = definePlugin("act", () => ({
      tools: [
        gatedAction({
          name: "decide",
          gate(args, ctx) {
            gateCtx = { ...ctx };
            return { title: "Decide?", options: [{ id: "yes", label: "Yes" }] };
          },
          async run(ctx) {
            runCtx = { ...ctx };
            return "decided";
          },
        }),
      ],
    }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin: action, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    test.model.respond([toolCall("decide"), text("waiting for approval")]);
    await test.agent.host.submitInput(id, "go");

    const proposal = await waitForProposal(test.agent.host, id);
    await waitFor(() => gateCtx !== undefined);
    expect(gateCtx?.conversationId).toBe(id);
    expect(gateCtx?.store).toBeDefined();
    expect(gateCtx?.case).toBeDefined();
    expect(gateCtx?.files).toBeDefined();
    expect(gateCtx?.models).toBeDefined();
    expect(gateCtx).not.toHaveProperty("storage");
    expect(gateCtx).not.toHaveProperty("taskId");

    test.model.append([text("done")]);
    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
    });
    await waitForIdle(test.agent.host, id);
    await waitFor(() => runCtx !== undefined);
    expect(runCtx?.conversationId).toBe(id);
    expect(runCtx?.signal).toBeInstanceOf(AbortSignal);
    expect(runCtx?.store).toBeDefined();
    expect(runCtx?.case).toBeDefined();
    expect(runCtx?.files).toBeDefined();
    expect(runCtx?.models).toBeDefined();
    expect(runCtx).not.toHaveProperty("storage");
    expect(runCtx).not.toHaveProperty("taskId");

    // The proposal is settled before `run` executes, so it is no longer open.
    expect(await test.agent.host.listProposals({ conversationId: id })).toEqual([]);
  });

  it("runs an effect once and returns the recorded value for a repeated ctx.once key", async () => {
    const effects: string[] = [];
    const plugin = definePlugin("once", () => ({
      tools: [
        defineTool({
          name: "touch",
          description: "Does an effect once.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_args, ctx: ToolContext) {
            const firstVal = await ctx.once("k", async () => {
              effects.push("touched");
              return "value";
            });
            const secondVal = await ctx.once("k", async () => {
              effects.push("again");
              return "value";
            });
            return [firstVal, secondVal].join(",");
          },
        }),
      ],
    }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    test.model.respond([toolCall("touch"), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(effects).toEqual(["touched"]);
    const read = await test.agent.host.readConversation(id);
    expect(JSON.stringify(read.entries)).toContain("value,value");
  });
});
