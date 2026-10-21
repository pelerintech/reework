import { describe, expect, it } from "vitest";
import { CONTEXT } from "@reework/core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  authedApp,
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

type Created = { id: string; key?: string; created: boolean };

async function create(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  body?: object,
) {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as Created };
}

describe("conversations", () => {
  it("creates a new conversation that is not the agent's root", async () => {
    const agent = await startTestAgent(testDefinition());
    const { status, body } = await create(authedApp(agent));
    expect(status).toBe(201);
    const root = await agent.engine.harness.root(CONTEXT);
    expect(body.id).not.toBe(String(root.id));
  });

  it("returns the same conversation for the same key, including after a restart", async () => {
    const storagePath = tmpStorage();
    const first = await startTestAgent(testDefinition(), { storagePath });
    const a = await create(authedApp(first), { key: "k1" });
    const b = await create(authedApp(first), { key: "k1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    untrack(first);
    await first.stop();

    const second = await startTestAgent(testDefinition(), { storagePath });
    const c = await create(authedApp(second), { key: "k1" });
    expect(c.status).toBe(200);
    expect(c.body.id).toBe(a.body.id);
  });

  it("keeps each conversation's messages to itself", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("answer for A")]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const a = (await create(authedApp(agent))).body;
    const b = (await create(authedApp(agent))).body;

    await agent.host.submitInput(a.id, "question for A", { wait: true });

    const readA = await (await authedApp(agent).request(`/conversations/${a.id}`)).text();
    const readB = await (await authedApp(agent).request(`/conversations/${b.id}`)).text();
    expect(readA).toContain("answer for A");
    expect(readB).not.toContain("answer for A");
    expect(readB).not.toContain("question for A");
  });

  it("answers 404 for ids that were never created and for the root conversation", async () => {
    const agent = await startTestAgent(testDefinition());
    const root = await agent.engine.harness.root(CONTEXT);
    for (const id of ["999999", String(root.id)]) {
      expect((await authedApp(agent).request(`/conversations/${id}`)).status).toBe(404);
      const post = await authedApp(agent).request(`/conversations/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      });
      expect(post.status).toBe(404);
    }
  });

  it("accepts a message at once and answers it in the background", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const faux = fauxModels();
    faux.respond([
      async () => {
        await held;
        return fauxAssistantMessage("late answer");
      },
    ]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = (await create(authedApp(agent))).body;

    const res = await authedApp(agent).request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "take your time" }),
    });
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as { conversationId: string; submissionId: string };
    expect(accepted.conversationId).toBe(id);
    expect(accepted.submissionId).toBeTruthy();
    expect(await (await authedApp(agent).request(`/conversations/${id}`)).text()).not.toContain(
      "late answer",
    );

    release();
    await eventually(async () =>
      (await (await authedApp(agent).request(`/conversations/${id}`)).text()).includes(
        "late answer",
      ),
    );
  });

  it("returns the assistant message when asked to wait", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("right away")]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = (await create(authedApp(agent))).body;

    const res = await authedApp(agent).request(`/conversations/${id}/messages?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "now please" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { role: string; content: unknown } };
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toEqual([{ type: "text", text: "right away" }]);
  });

  it("lists every created conversation with its key and creation time, but not root", async () => {
    const agent = await startTestAgent(testDefinition());
    const plain = (await create(authedApp(agent))).body;
    const keyed = (await create(authedApp(agent), { key: "incident-7" })).body;
    const root = await agent.engine.harness.root(CONTEXT);

    const res = await authedApp(agent).request("/conversations");
    expect(res.status).toBe(200);
    const { conversations } = (await res.json()) as {
      conversations: { id: string; key?: string; createdAt: number }[];
    };
    expect(conversations.map((c) => c.id)).toEqual([plain.id, keyed.id]);
    expect(conversations[1].key).toBe("incident-7");
    expect(conversations.every((c) => typeof c.createdAt === "number")).toBe(true);
    expect(conversations.map((c) => c.id)).not.toContain(String(root.id));
  });

  it("does not submit twice for a repeated requestId, including after a restart", async () => {
    const storagePath = tmpStorage();
    const send = (app: ReturnType<typeof authedApp>, id: string) =>
      app.request(`/conversations/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "alert fired", requestId: "alert-1" }),
      });
    const first = await startTestAgent(testDefinition(), { storagePath });
    const { id } = (await create(authedApp(first))).body;

    const r1 = await send(authedApp(first), id);
    const r2 = await send(authedApp(first), id);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(200);
    const s1 = ((await r1.json()) as { submissionId: string }).submissionId;
    expect(((await r2.json()) as { submissionId: string }).submissionId).toBe(s1);
    await eventually(async () => (await first.host.readConversation(id)).entries.length >= 2);
    untrack(first);
    await first.stop();

    const second = await startTestAgent(testDefinition(), { storagePath });
    const r3 = await send(authedApp(second), id);
    expect(r3.status).toBe(200);
    expect(((await r3.json()) as { submissionId: string }).submissionId).toBe(s1);
    const inputs = (await second.host.readConversation(id)).entries.filter(
      (e) => e.kind === "pi.user",
    );
    expect(inputs).toHaveLength(1);
  });
});
