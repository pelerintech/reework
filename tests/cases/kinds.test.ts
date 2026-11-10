// Conversation kinds: a desk is a conversation that is not a case. Created as a desk
// through the host, HTTP and the client; an ordinary conversation is a case; and a
// record stored before kinds existed reads as a case.
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin } from "@reework/core";
import {
  seedLegacyCase,
  startTestAgent as startKitAgent,
  text,
  toolCall,
} from "@reework/core/testing";
import { authedApp, startTestAgent, testDefinition, TEST_TOKEN } from "../support/agent.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("conversation kinds at creation", () => {
  it("creates desks through the host, HTTP and the client, and cases by default", async () => {
    const test = await startTestAgent(testDefinition());
    const app = authedApp(test);

    const ordinary = await test.host.createConversation({ key: "ordinary" });
    expect((await test.host.getCase(ordinary.id)).kind).toBe("case");

    const desk = await test.host.createConversation({ key: "desk", kind: "desk" });
    expect((await test.host.getCase(desk.id)).kind).toBe("desk");

    const created = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "http-desk", kind: "desk" }),
    });
    expect(created.status).toBe(201);
    const httpDesk = (await created.json()) as { id: string };
    expect((await test.host.getCase(httpDesk.id)).kind).toBe("desk");

    const { port } = await test.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    const clientDesk = await client.createConversation({ key: "client-desk", kind: "desk" });
    expect((await client.getCase(clientDesk.id)).kind).toBe("desk");
    const clientCase = await client.createConversation({ key: "client-case" });
    expect((await client.getCase(clientCase.id)).kind).toBe("case");
  });

  it("keeps desks out of case lists and filters by kind and owner", async () => {
    const test = await startTestAgent(testDefinition());
    const app = authedApp(test);
    // A principal's ownership is one stable author, not each channel identity.
    const ana = { kind: "human", id: "principal:ana" } as const;
    const a = await test.host.createConversation({ key: "a", case: { owner: ana } });
    const b = await test.host.createConversation({
      key: "b",
      case: { owner: { kind: "agent", id: "agent:orchestrator" } },
    });
    const desk = await test.host.createConversation({ key: "desk", kind: "desk" });
    const c = await test.host.createConversation({ key: "c", case: { owner: ana } });

    const ids = async (filter: Parameters<typeof test.host.listCases>[0] = {}) =>
      (await test.host.listCases(filter)).map((x) => x.id).sort();

    expect(await ids()).toEqual([a.id, b.id, c.id].sort());
    expect(await ids({ kind: ["desk"] })).toEqual([desk.id]);
    expect(await ids({ kind: ["case"] })).toEqual([a.id, b.id, c.id].sort());
    expect(await ids({ owner: ana })).toEqual([a.id, c.id].sort());
    expect(await ids({ kind: ["desk"], owner: ana })).toEqual([]);

    const deskRes = await app.request("/conversations?kind=desk");
    expect(((await deskRes.json()) as { cases: { id: string }[] }).cases.map((x) => x.id)).toEqual([
      desk.id,
    ]);
    const caseRes = await app.request("/conversations?kind=case");
    expect(
      ((await caseRes.json()) as { cases: { id: string }[] }).cases.map((x) => x.id).sort(),
    ).toEqual([a.id, b.id, c.id].sort());
    const ownerRes = await app.request("/conversations?ownerKind=human&ownerId=principal:ana");
    expect(
      ((await ownerRes.json()) as { cases: { id: string }[] }).cases.map((x) => x.id).sort(),
    ).toEqual([a.id, c.id].sort());
  });

  it("refuses to close a desk on every write path and accepts input", async () => {
    const closed: string[] = [];
    const recorder = definePlugin("recorder", () => ({
      hooks: {
        async onCaseClosed({ case: c }) {
          closed.push(c.id);
        },
      },
    }));
    const test = await startKitAgent(
      testDefinition({ plugins: [{ plugin: recorder, config: {} }] }),
    );
    running.push(test);
    const app = {
      request(path: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${test.token}`);
        return test.agent.app.request(path, { ...init, headers });
      },
    };
    const desk = await test.agent.host.createConversation({ key: "desk", kind: "desk" });

    await expect(test.agent.host.updateCase(desk.id, { status: "closed" })).rejects.toThrow(
      /cannot close a desk/,
    );
    const res = await app.request(`/conversations/${desk.id}/case`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot close a desk/);

    test.model.respond([toolCall("update_case", { status: "closed" }), text("could not close")]);
    await test.agent.host.submitInput(desk.id, "close it", { wait: true });
    const read = await test.agent.host.readConversation(desk.id);
    expect(JSON.stringify(read.entries)).toContain("cannot close a desk");
    const snapshot = await test.agent.host.snapshot(desk.id);
    expect(snapshot.transcript.find((item) => item.type === "tool")?.status).toBe("error");

    await sleep(100);
    expect(closed).toEqual([]);
    expect((await test.agent.host.getCase(desk.id)).status).toBe("open");

    const accepted = await test.agent.host.submitInput(desk.id, "more work");
    expect(accepted.submissionId).toBeTruthy();
    expect((await test.agent.host.getCase(desk.id)).status).toBe("open");
  });

  it("reads a record stored without a kind as a case", async () => {
    const test = await startTestAgent(testDefinition());
    const legacy = await seedLegacyCase(test, { key: "legacy" });
    expect((await test.host.getCase(legacy)).kind).toBe("case");
    expect((await test.host.listCases()).find((c) => c.id === legacy)?.kind).toBe("case");
  });
});
