// A surface must know how each tool call went, and what is running when it attaches.
import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import type { WatchFrame } from "@reework/client";
import type { AgentEvent, TranscriptItem } from "@reework/types";
import { Type, defineTool, definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent, text, toolCall, waitFor, waitForIdle } from "@reework/core/testing";

function toolsPlugin(gate: Promise<void>) {
  return definePlugin("tools", () => ({
    tools: [
      defineTool({
        name: "lookup",
        description: "Look something up",
        parameters: Type.Object({ q: Type.String() }),
        execute: async () => ({ output: [{ type: "text" as const, text: "found" }] }),
      }),
      defineTool({
        name: "broken",
        description: "Always fails",
        parameters: Type.Object({}),
        execute: async () => {
          throw new Error("backend down");
        },
      }),
      defineTool({
        name: "slow",
        description: "Takes a while",
        parameters: Type.Object({}),
        execute: async () => {
          await gate;
          return { output: [{ type: "text" as const, text: "finished" }] };
        },
      }),
    ],
  }));
}

function definition(gate: Promise<void>): AgentDefinition {
  return {
    name: "tools-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin: toolsPlugin(gate), config: {} }],
    channels: [],
    mission: { role: "You use tools." },
  };
}

async function setup() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const test = await startTestAgent(definition(gate));
  const { port, close } = await test.agent.listen(0);
  const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
  const { id } = await test.agent.host.createConversation();
  const done = async () => {
    release();
    await close();
    await test.dispose();
  };
  return { ...test, client, id, release, done };
}

async function snapshotOf(client: ReturnType<typeof createClient>, id: string) {
  let snapshot: Extract<WatchFrame, { kind: "snapshot" }> | undefined;
  const watch = await client.watch(id, (frame) => {
    if (frame.kind === "snapshot") snapshot = frame;
  });
  const frame = await waitFor(() => snapshot);
  watch.close();
  return frame;
}

const tools = (items: readonly TranscriptItem[]) => items.filter((i) => i.type === "tool");

describe("tool state on the protocol", () => {
  it("says whether each tool call failed", async () => {
    const { agent, model, client, id, done } = await setup();
    model.respond([toolCall("lookup", { q: "x" }), toolCall("broken"), text("done")]);
    const ends: AgentEvent[] = [];
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "events")
        ends.push(...frame.events.filter((e) => e.kind === "tool_execution_end"));
    });
    await agent.host.submitInput(id, "go", { wait: true });
    await waitFor(() => ends.length === 2);
    expect(ends.map((e) => (e as { isError: boolean }).isError)).toEqual([false, true]);
    watch.close();
    await done();
  });

  it("puts past tool calls in the snapshot's transcript, in order with the messages", async () => {
    const { agent, model, client, id, done } = await setup();
    model.respond([toolCall("lookup", { q: "x" }), toolCall("broken"), text("all done")]);
    await agent.host.submitInput(id, "go", { wait: true });
    await waitForIdle(agent.host, id);

    const { transcript } = await snapshotOf(client, id);
    const shape = transcript.map((item) =>
      item.type === "message" ? `${item.role}:${item.text}` : `tool:${item.name}:${item.status}`,
    );
    expect(shape).toEqual([
      "user:go",
      "tool:lookup:done",
      "tool:broken:error",
      "assistant:all done",
    ]);
    const [lookup] = tools(transcript);
    expect(lookup).toMatchObject({ args: { q: "x" } });
    expect(lookup.type === "tool" && lookup.endedAt! >= lookup.startedAt).toBe(true);
    await done();
  });

  it("shows a tool that is running when the watch attaches", async () => {
    const { agent, model, client, id, release, done } = await setup();
    model.respond([toolCall("slow"), text("finished")]);
    await agent.host.submitInput(id, "go");
    await waitFor(async () => {
      const entries = (await agent.host.readConversation(id)).entries;
      return entries.some((e) => e.kind === "pi.assistant");
    });

    const { transcript, running } = await snapshotOf(client, id);
    expect(running).toBe(true);
    expect(tools(transcript)).toMatchObject([{ name: "slow", status: "running" }]);
    release();
    await waitForIdle(agent.host, id);
    await done();
  });
});
