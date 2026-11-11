// The view model turns the watch stream into what a surface shows: a transcript of
// messages and tool calls, whether the agent is busy, and the open proposals.
import { describe, expect, it } from "vitest";
import { applyFrame, createClient, emptyView } from "@reework/client";
import type { ConversationView } from "@reework/client";
import { Type, defineTool, definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import {
  startTestAgent,
  text,
  toolCall,
  waitFor,
  waitForIdle,
  waitForProposal,
} from "@reework/core/testing";

function setupDefinition(gate: Promise<void>): AgentDefinition {
  const plugin = definePlugin("ops", () => ({
    tools: [
      defineTool({
        name: "check",
        description: "Quick check",
        parameters: Type.Object({}),
        execute: async () => "ok",
      }),
      defineTool({
        name: "scan",
        description: "Slow scan",
        parameters: Type.Object({ depth: Type.Number() }),
        execute: async () => {
          await gate;
          return "clean";
        },
      }),
      gatedAction({
        name: "fix",
        gate: { title: "Apply the fix?", options: [{ id: "yes", label: "Apply" }] },
        run: async () => "fixed",
      }),
    ],
  }));
  return {
    name: "viewer",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You check things." },
  };
}

async function setup() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const test = await startTestAgent(setupDefinition(gate));
  const server = await test.agent.listen(0);
  const client = createClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: test.token });
  const { id } = await test.agent.host.createConversation();
  return {
    ...test,
    client,
    id,
    release,
    done: async () => {
      release();
      await server.close();
      await test.dispose();
    },
  };
}

async function follow(client: ReturnType<typeof createClient>, id: string) {
  const state = { view: emptyView(id) as ConversationView, snapshots: 0 };
  const watch = await client.watch(id, (frame) => {
    state.view = applyFrame(state.view, frame);
    if (frame.kind === "snapshot") state.snapshots += 1;
  });
  await waitFor(() => state.snapshots === 1);
  return { state, close: () => watch.close() };
}

const shape = (view: ConversationView) =>
  view.items.map((item) =>
    item.type === "message" ? `${item.role}:${item.text}` : `tool:${item.name}:${item.status}`,
  );

describe("the conversation view", () => {
  it("folds history and live events into one transcript", async () => {
    const { agent, model, client, id, release, done } = await setup();
    model.respond([toolCall("check"), text("all good")]);
    await agent.host.submitInput(id, "check it", { wait: true });

    const { state, close } = await follow(client, id);
    expect(shape(state.view)).toEqual(["user:check it", "tool:check:done", "assistant:all good"]);

    model.append([
      toolCall("scan", { depth: 2 }),
      toolCall("fix"),
      text("scan was clean, fix proposed"),
    ]);
    await agent.host.submitInput(id, "scan deeper");
    await waitFor(() => state.view.running);
    const scan = await waitFor(() =>
      state.view.items.find(
        (i) => i.type === "tool" && i.name === "scan" && i.status === "running",
      ),
    );
    expect(scan).toMatchObject({ args: { depth: 2 } });
    release();

    const proposal = await waitForProposal(agent.host, id);
    await waitFor(() => state.view.proposals.some((p) => p.id === proposal.id));
    await waitForIdle(agent.host, id);
    await waitFor(() => !state.view.running);
    expect(shape(state.view)).toEqual([
      "user:check it",
      "tool:check:done",
      "assistant:all good",
      "user:scan deeper",
      "tool:scan:done",
      "tool:fix:done",
      "assistant:scan was clean, fix proposed",
    ]);
    const done1 = state.view.items.find((i) => i.type === "tool" && i.name === "scan");
    expect(done1?.type === "tool" && done1.endedAt! >= done1.startedAt).toBe(true);
    const answers = state.view.items.filter((i) => i.type === "message" && i.role === "assistant");
    expect(answers.every((m) => m.type === "message" && !m.streaming)).toBe(true);

    model.append([text("applied")]);
    await client.decide({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await waitFor(() => state.view.proposals.length === 0);
    close();
    await done();
  });

  it("keeps the input author on the view's user message", async () => {
    const { agent, model, client, id, done } = await setup();
    model.respond([text("hi there")]);
    const from = { kind: "system" as const, id: "alerts" };
    await agent.host.submitInput(id, "hello", { from, wait: true });

    const { state, close } = await follow(client, id);
    const user = state.view.items.find((i) => i.type === "message" && i.role === "user");
    expect(user).toMatchObject({ text: "hello", from });

    close();
    await done();
  });

  it("shows a tool as running when the view starts mid-tool", async () => {
    const { agent, model, client, id, release, done } = await setup();
    model.respond([toolCall("scan", { depth: 1 }), text("done")]);
    await agent.host.submitInput(id, "scan");
    await waitFor(async () =>
      (await agent.host.readConversation(id)).entries.some((e) => e.kind === "pi.assistant"),
    );

    const { state, close } = await follow(client, id);
    expect(state.view.running).toBe(true);
    expect(shape(state.view)).toEqual(["user:scan", "tool:scan:running"]);
    release();
    await waitFor(() => shape(state.view).includes("tool:scan:done"));
    expect(shape(state.view).filter((s) => s.startsWith("tool:scan"))).toHaveLength(1);
    close();
    await done();
  });
});
