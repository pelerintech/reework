// Event hooks: plugins learn about input after it is admitted, once per input, through
// a per-agent queue that never delays the caller.
import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin } from "@reework/core";
import type { AgentDefinition, PluginEventContext } from "@reework/core";
import { startTestAgent, text } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";

interface Seen {
  readonly input: { conversationId: string; submissionId: string; content: string; from?: unknown };
  readonly ctx: PluginEventContext;
}

function definition(plugin: ReturnType<typeof definePlugin>): AgentDefinition {
  return {
    name: "event-agent",
    model: {
      provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" },
      modelId: "m1",
    },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You answer." },
  };
}

describe("event hooks: onInput", () => {
  it("fires once after admission with the input and a full context", async () => {
    const seen: Seen[] = [];
    const plugin = definePlugin("watch", () => ({
      hooks: {
        async onInput(input, ctx) {
          seen.push({ input, ctx });
        },
      },
    }));
    const test = await startTestAgent(definition(plugin));
    test.model.respond([text("answer")]);
    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await client.createConversation();

    await client.submit(id, "hi", { from: { kind: "human" } });
    const first = await eventually(() => seen[0]);
    expect(first.input).toMatchObject({
      conversationId: id,
      content: "hi",
      from: { kind: "human" },
    });
    expect(first.input.submissionId).toBeTruthy();

    expect(first.ctx.conversationId).toBe(id);
    expect(typeof first.ctx.store.agent.get).toBe("function");
    expect(typeof first.ctx.store.case.get).toBe("function");
    expect(typeof first.ctx.files.list).toBe("function");
    expect(typeof first.ctx.case.get).toBe("function");
    expect(typeof first.ctx.models.complete).toBe("function");

    // A repeat of the same request id admits nothing and fires nothing.
    await client.submit(id, "hi", { from: { kind: "human" }, requestId: "r1" });
    await client.submit(id, "hi", { from: { kind: "human" }, requestId: "r1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(2);

    await test.dispose();
  });

  it("does not delay the caller when the hook is slow", async () => {
    const plugin = definePlugin("slow", () => ({
      hooks: {
        async onInput() {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        },
      },
    }));
    const test = await startTestAgent(definition(plugin));
    test.model.respond([text("answer")]);
    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await client.createConversation();

    const begun = Date.now();
    await client.submit(id, "hi");
    expect(Date.now() - begun).toBeLessThan(1000);

    await test.dispose();
  });
});
