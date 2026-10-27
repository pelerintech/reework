import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin, gatedAction } from "@reework/core";
import {
  startTestAgent as startKitAgent,
  text,
  toolCall,
  waitForProposal,
} from "@reework/core/testing";
import {
  startTestAgent,
  testDefinition,
  authedApp,
  TEST_TOKEN,
  fauxModels,
} from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("cases over the protocol and the client", () => {
  it("serves filtered case listings and per-case reads/updates", async () => {
    const agent = await startTestAgent(testDefinition());
    const app = authedApp(agent);
    const a = await agent.host.createConversation({ key: "a" });
    const b = await agent.host.createConversation({ key: "b" });
    await agent.host.updateCase(a.id, { status: "closed", priority: "high", tags: ["x"] });
    await agent.host.updateCase(b.id, { status: "waiting", priority: "normal", tags: ["x", "y"] });

    // GET /conversations?status=closed → only a.
    const closedRes = await app.request("/conversations?status=closed");
    const closed = (await closedRes.json()) as { cases: { id: string }[] };
    expect(closed.cases.map((c) => c.id)).toEqual([a.id]);

    // tag=x&tag=y (all must match) → only b.
    const taggedRes = await app.request("/conversations?tag=x&tag=y");
    const tagged = (await taggedRes.json()) as { cases: { id: string }[] };
    expect(tagged.cases.map((c) => c.id)).toEqual([b.id]);

    // GET /conversations/:id/case.
    const caseRes = await app.request(`/conversations/${a.id}/case`);
    expect(caseRes.status).toBe(200);
    expect(((await caseRes.json()) as { status: string }).status).toBe("closed");

    // POST /conversations/:id/case valid.
    const ok = await app.request(`/conversations/${a.id}/case`, {
      method: "POST",
      body: JSON.stringify({ stage: "triaged" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { stage: string }).stage).toBe("triaged");

    // POST invalid patch → 400 naming the field.
    const bad = await app.request(`/conversations/${a.id}/case`, {
      method: "POST",
      body: JSON.stringify({ nope: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/nope/);
  });

  it("the client lists, reads and updates cases", async () => {
    const test = await startKitAgent(testDefinition());
    running.push(test);
    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await client.createConversation({ key: "lead" });
    await client.updateCase(id, { stage: "investigating", priority: "high" });
    const c = await client.getCase(id);
    expect(c.stage).toBe("investigating");
    expect(c.priority).toBe("high");
    const all = await client.listCases();
    expect(all.map((x) => x.id)).toContain(id);
  });

  it("filters by stage over HTTP and the client", async () => {
    const test = await startTestAgent(testDefinition());
    const app = authedApp(test);
    const a = await test.host.createConversation({ key: "stage-a" });
    const b = await test.host.createConversation({ key: "stage-b" });
    await test.host.updateCase(a.id, { stage: "triaged" });
    await test.host.updateCase(b.id, { stage: "diagnosed" });

    const res = await app.request("/conversations?stage=triaged");
    const cases = ((await res.json()) as { cases: { id: string; stage?: string }[] }).cases;
    expect(cases.map((c) => c.id)).toEqual([a.id]);
    expect(cases[0]!.stage).toBe("triaged");

    const { port } = await test.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    expect((await client.listCases({ stage: "triaged" })).map((c) => c.id)).toEqual([a.id]);
  });

  it("filters needsHuman both ways and sorts by createdAt", async () => {
    const faux = fauxModels();
    faux.respond([toolCall("approve"), text("asked")]);
    const approve = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "approve",
          gate: { title: "Approve?", options: [{ id: "yes", label: "Yes" }] },
          run: async () => "ok",
        }),
      ],
    }));
    const test = await startTestAgent(
      testDefinition({ plugins: [{ plugin: approve, config: {} }] }),
      {
        models: faux.models,
      },
    );
    const app = authedApp(test);
    const needs = await test.host.createConversation({ key: "needs" });
    const notNeeds = await test.host.createConversation({ key: "not-needs" });
    await test.host.submitInput(needs.id, "go");
    await waitForProposal(test.host, needs.id);

    const trueRes = await app.request("/conversations?needsHuman=true");
    expect(((await trueRes.json()) as { cases: { id: string }[] }).cases.map((c) => c.id)).toEqual([
      needs.id,
    ]);
    const falseRes = await app.request("/conversations?needsHuman=false");
    expect(((await falseRes.json()) as { cases: { id: string }[] }).cases.map((c) => c.id)).toEqual(
      [notNeeds.id],
    );

    const { port } = await test.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    expect((await client.listCases({ needsHuman: false })).map((c) => c.id)).toEqual([notNeeds.id]);

    const first = await test.host.createConversation({ key: "created-first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await test.host.createConversation({ key: "created-second" });
    await test.host.updateCase(first.id, { stage: "touched" });

    const byCreated = await test.host.listCases({ sort: "createdAt" });
    expect(byCreated.map((c) => c.id)).toEqual([second.id, first.id, notNeeds.id, needs.id]);
    const createdRes = await app.request("/conversations?sort=createdAt");
    expect(
      ((await createdRes.json()) as { cases: { id: string }[] }).cases.map((c) => c.id),
    ).toEqual([second.id, first.id, notNeeds.id, needs.id]);
  });
});

describe("case sorts", () => {
  it("orders by priority and by due date over host, HTTP and the client", async () => {
    const test = await startTestAgent(testDefinition());
    const app = authedApp(test);

    const urgent = await test.host.createConversation({ key: "urgent" });
    const high = await test.host.createConversation({ key: "high" });
    const normalOld = await test.host.createConversation({ key: "normal-old" });
    const normalNew = await test.host.createConversation({ key: "normal-new" });
    const low = await test.host.createConversation({ key: "low" });
    await test.host.updateCase(urgent.id, { priority: "urgent" });
    await test.host.updateCase(high.id, { priority: "high" });
    await test.host.updateCase(normalOld.id, { priority: "normal" });
    await test.host.updateCase(normalNew.id, { priority: "normal" });
    await test.host.updateCase(low.id, { priority: "low" });
    // The later update gives normalNew a newer updatedAt, so it sorts before normalOld.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await test.host.updateCase(normalNew.id, { stage: "touched" });

    const expectedPriority = [urgent.id, high.id, normalNew.id, normalOld.id, low.id];
    expect((await test.host.listCases({ sort: "priority" })).map((c) => c.id)).toEqual(
      expectedPriority,
    );
    const priorityRes = await app.request("/conversations?sort=priority");
    expect(
      ((await priorityRes.json()) as { cases: { id: string }[] }).cases.map((c) => c.id),
    ).toEqual(expectedPriority);

    const { port } = await test.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    expect((await client.listCases({ sort: "priority" })).map((c) => c.id)).toEqual(
      expectedPriority,
    );
  });

  it("orders by due date soonest first with none last", async () => {
    const test = await startTestAgent(testDefinition());
    const app = authedApp(test);
    const soon = await test.host.createConversation({ key: "due-soon" });
    const later = await test.host.createConversation({ key: "due-later" });
    const none = await test.host.createConversation({ key: "due-none" });
    await test.host.updateCase(later.id, { dueAt: Date.now() + 3 * 86_400_000 });
    await test.host.updateCase(soon.id, { dueAt: Date.now() + 86_400_000 });

    const expected = [soon.id, later.id, none.id];
    expect((await test.host.listCases({ sort: "dueAt" })).map((c) => c.id)).toEqual(expected);
    const dueRes = await app.request("/conversations?sort=dueAt");
    expect(((await dueRes.json()) as { cases: { id: string }[] }).cases.map((c) => c.id)).toEqual(
      expected,
    );
    const { port } = await test.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    expect((await client.listCases({ sort: "dueAt" })).map((c) => c.id)).toEqual(expected);
  });
});
