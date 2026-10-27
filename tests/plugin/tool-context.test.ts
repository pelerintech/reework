import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@reework/core";
import { definePlugin, defineTool } from "@reework/core";
import type { ToolContext } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor } from "@reework/core/testing";
import { createClient } from "@reework/client";
import type { AgentEvent } from "@reework/types";

const agent = {
  name: "toolctx",
  model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [],
  channels: [],
  mission: { role: "You are a test agent." },
};

const running: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.dispose();
});

describe("the reework tool context", () => {
  it("gives a tool the conversation id, a signal and a string result", async () => {
    let seen: ToolContext | undefined;
    const recorder = definePlugin("rec", () => ({
      tools: [
        defineTool({
          name: "record",
          description: "Records its context.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_args, ctx) {
            seen = ctx;
            return "recorded";
          },
        }),
      ],
    }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin: recorder, config: {} }] });
    running.push(test);
    const conversation = await test.agent.host.createConversation();
    test.model.respond([toolCall("record"), text("done")]);
    await test.agent.host.submitInput(conversation.id, "go", { wait: true });

    expect(seen?.conversationId).toBe(conversation.id);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    const read = await test.agent.host.readConversation(conversation.id);
    expect(JSON.stringify(read.entries)).toContain("recorded");
  });

  it("routes error results and throws to the model, and the watch marks them failed", async () => {
    const failing = definePlugin("fail", () => ({
      tools: [
        defineTool({
          name: "bad",
          description: "Returns an error result.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            return { output: "bad output", isError: true };
          },
        }),
        defineTool({
          name: "boom",
          description: "Throws.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            throw new Error("exploded");
          },
        }),
      ],
    }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin: failing, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    const server = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: test.token });
    const events: AgentEvent[] = [];
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "events") events.push(...frame.events);
    });
    test.model.respond([toolCall("bad"), toolCall("boom"), text("finished")]);
    const reply = await test.agent.host.submitInput(id, "go", { wait: true });
    expect(reply.message?.content).toEqual([{ type: "text", text: "finished" }]);

    const read = await test.agent.host.readConversation(id);
    const text_ = JSON.stringify(read.entries);
    expect(text_).toContain("bad output");
    expect(text_).toContain("exploded");
    // The watch stream marks both the returned-error and the thrown tool failed.
    const errors = await waitFor(() => {
      const errs = events.filter((e) => e.kind === "tool_execution_end" && e.isError === true);
      return errs.length >= 2 ? errs : undefined;
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    watch.close();
    await server.close();
  });

  it("emits running output through ctx.output as a tool_execution_update", async () => {
    const eyedropper = definePlugin("eye", () => ({
      tools: [
        defineTool({
          name: "tick",
          description: "Emits progress then returns.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_args, ctx) {
            ctx.output("progress 50%");
            return "ticked";
          },
        }),
      ],
    }));
    const test = await startTestAgent({ ...agent, plugins: [{ plugin: eyedropper, config: {} }] });
    running.push(test);
    const { id } = await test.agent.host.createConversation();
    const server = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: test.token });
    const events: AgentEvent[] = [];
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "events") events.push(...frame.events);
    });
    test.model.respond([toolCall("tick"), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });
    await waitFor(() =>
      events.some((e) => e.kind === "tool_execution_update" && e.output.includes("progress 50%")),
    );
    watch.close();
    await server.close();
  });
});
