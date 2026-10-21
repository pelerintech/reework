import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createClient } from "@reework/client";
import { definePlugin, gatedAction } from "@reework/core";
import { answerProposal, loadStartState, sendToAgent } from "@reework/tui";
import { TEST_TOKEN, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

/** A listening agent with gates open in two conversations, plus one quiet conversation. */
export async function agentWithTwoGates() {
  const faux = fauxModels();
  const ask = (title: string) => [
    fauxAssistantMessage([fauxToolCall("approve", { title })], { stopReason: "toolUse" }),
    fauxAssistantMessage(`asked: ${title}`),
  ];
  faux.respond([...ask("Restart worker?"), ...ask("Roll out fix?")]);
  const plugin = definePlugin("ops", () => ({
    tools: [
      gatedAction({
        name: "approve",
        parameters: Type.Object({ title: Type.String() }),
        gate: (args) => ({
          title: args.title,
          options: [{ id: "yes", label: "Yes" }],
          acceptFreeForm: true,
        }),
        run: async () => "done",
      }),
    ],
  }));
  const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
    models: faux.models,
  });
  const { port } = await agent.listen(0);
  const a = await agent.host.createConversation({ key: "alert-a" });
  const b = await agent.host.createConversation({ key: "alert-b" });
  const quiet = await agent.host.createConversation({ key: "quiet" });
  await agent.host.submitInput(a.id, "check A", { wait: true });
  await agent.host.submitInput(b.id, "check B", { wait: true });
  const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
  return { agent, client, a, b, quiet };
}

describe("the TUI's start state", () => {
  it("is the inbox of open proposals across conversations, and every conversation", async () => {
    const { client, a, b, quiet } = await agentWithTwoGates();

    const state = await loadStartState(client);

    expect(state.inbox.map((p) => [p.title, p.conversationId])).toEqual([
      ["Restart worker?", a.id],
      ["Roll out fix?", b.id],
    ]);
    expect(state.conversations.map((c) => c.key)).toEqual(["alert-a", "alert-b", "quiet"]);
    expect(state.conversations.map((c) => c.id)).toContain(quiet.id);
  });

  it("answers each inbox proposal in its own conversation, by option or by instruction", async () => {
    const { agent, client, a, b } = await agentWithTwoGates();
    const { inbox } = await loadStartState(client);
    const [inA, inB] = inbox;

    expect(await answerProposal(client, inB, "yes")).toEqual({ kind: "option", optionId: "yes" });
    expect(await answerProposal(client, inA, "only restart the canary")).toEqual({
      kind: "instruction",
      instruction: "only restart the canary",
    });

    expect((await loadStartState(client)).inbox).toEqual([]);
    await eventually(async () =>
      JSON.stringify(await agent.host.readConversation(a.id)).includes("only restart the canary"),
    );
    expect(JSON.stringify(await agent.host.readConversation(b.id))).toContain('option \\"yes\\"');
  });

  it("sends input without waiting; the answer arrives on the conversation's event stream", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const faux = fauxModels();
    faux.respond([
      async () => {
        await held;
        return fauxAssistantMessage("took a while");
      },
    ]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { port } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    const { id } = await client.createConversation();
    const kinds: string[] = [];
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "events") kinds.push(...frame.events.map((e) => e.kind));
    });

    const sent = await sendToAgent(client, id, "investigate the latency");
    expect(sent.submissionId).toBeTruthy();
    expect(kinds).not.toContain("run_end");

    release();
    await eventually(() => kinds.includes("run_end"));
    watch.close();
    expect(JSON.stringify(await client.readConversation(id))).toContain("took a while");
  });
});
