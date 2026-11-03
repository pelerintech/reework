import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createClient } from "@reework/client";
import type { WatchFrame } from "@reework/client";
import { definePlugin, gatedAction } from "@reework/core";
import { TEST_TOKEN, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

async function listeningAgent(steps: Parameters<ReturnType<typeof fauxModels>["respond"]>[0]) {
  const faux = fauxModels();
  faux.respond(steps);
  const plugin = definePlugin("ops", () => ({
    tools: [
      gatedAction({
        name: "deploy",
        gate: { title: "Deploy?", options: [{ id: "go", label: "Go" }] },
        run: async () => "deployed",
      }),
    ],
  }));
  const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
    models: faux.models,
  });
  const { port } = await agent.listen(0);
  return createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
}

describe("@reework/client", () => {
  it("drives a whole gate flow: create, submit, see the proposal, decide, read the result", async () => {
    const client = await listeningAgent([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting on you"),
      fauxAssistantMessage("deploy confirmed"),
    ]);

    const conversation = await client.createConversation({ key: "release-9" });
    expect(conversation.created).toBe(true);
    const accepted = await client.submit(conversation.id, "ship it");
    expect(accepted.submissionId).toBeTruthy();

    const [proposal] = (await eventually(async () => {
      const open = await client.listProposals();
      return open.length > 0 ? open : undefined;
    }))!;
    expect(proposal.title).toBe("Deploy?");
    await client.decide({ proposalId: proposal.id, selectedOption: "go", instruction: null });

    await eventually(async () =>
      JSON.stringify(await client.readConversation(conversation.id)).includes("deploy confirmed"),
    );
    expect(await client.listProposals()).toEqual([]);
  });

  it("watches a conversation: a snapshot of its history first, then live deltas", async () => {
    const client = await listeningAgent([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
    ]);
    const { id } = await client.createConversation();
    await client.submit(id, "first question", { wait: true });

    const frames: WatchFrame[] = [];
    const watch = await client.watch(id, (frame) => frames.push(frame));
    await eventually(() => frames.length > 0);
    await client.submit(id, "second question", { wait: true });
    await eventually(() =>
      frames.some((f) => f.kind === "events" && f.events.some((e) => e.kind === "run_end")),
    );
    watch.close();
    // The server does not depend on its clients: it keeps serving after one detaches.
    expect((await client.health()).ok).toBe(true);

    const [snapshot] = frames;
    expect(snapshot.kind).toBe("snapshot");
    expect(JSON.stringify(snapshot)).toContain("first answer");
    expect(frames.slice(1).every((f) => f.kind === "events")).toBe(true);
  });
});

describe("@reework/client plugin requests", () => {
  it("calls a plugin route with the token and returns raw responses", async () => {
    const plugin = definePlugin("items", () => ({
      routes(app) {
        app.get("/list", (c) => c.json({ items: [1], auth: c.req.header("authorization") }));
        app.get("/gone", (c) => c.json({ error: "gone" }, 404));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });

    const list = await client.plugin("items").request("/list");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      items: [1],
      auth: `Bearer ${TEST_TOKEN}`,
    });

    const gone = await client.plugin("items").request("/gone");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "gone" });

    expect(() => client.plugin("items").request("list")).toThrow(/must start with/);
  });
});
