import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ROUTES } from "@reework/types";
import type { RouteId } from "@reework/types";
import { definePlugin, gatedAction } from "@reework/core";
import { authHeaders, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";

type Fixture = { params?: Record<string, string>; body?: object } | "websocket";

function upgrades(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: authHeaders });
    socket.once("open", () => {
      socket.close();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("the route table", () => {
  it("is the list of routes the server serves", async () => {
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("asked"),
      fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("asked"),
    ]);
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "act",
          gate: { title: "Act?", acceptFreeForm: true },
          run: async () => "ok",
        }),
      ],
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation();
    const b = await agent.host.createConversation();
    await agent.host.submitInput(a.id, "act", { wait: true });
    await agent.host.submitInput(b.id, "act", { wait: true });
    const [pa] = await agent.host.listProposals({ conversationId: a.id });
    const [pb] = await agent.host.listProposals({ conversationId: b.id });
    const decision = { selectedOption: null, instruction: "go ahead" };
    const file = await agent.host.addFile(a.id, { name: "x.txt", bytes: new Uint8Array([1]) });

    const fixtures: Record<RouteId, Fixture> = {
      health: {},
      "conversations.create": { body: { key: "k" } },
      "conversations.list": {},
      "conversations.get": { params: { id: a.id } },
      "conversations.getCase": { params: { id: a.id } },
      "conversations.updateCase": { params: { id: a.id }, body: { stage: "triage" } },
      "conversations.submit": { params: { id: a.id }, body: { content: "hello" } },
      "conversations.abort": { params: { id: b.id } },
      "conversations.files": { params: { id: a.id } },
      "conversations.uploadFile": { params: { id: a.id } },
      "conversations.downloadFile": { params: { id: a.id, fid: file.id } },
      "conversations.proposals": { params: { id: a.id } },
      "conversations.decide": { params: { id: a.id, pid: pa.id }, body: decision },
      "conversations.watch": "websocket",
      "proposals.list": {},
      "proposals.decide": { params: { pid: pb.id }, body: decision },
    };

    for (const [id, route] of Object.entries(ROUTES) as [RouteId, (typeof ROUTES)[RouteId]][]) {
      const fixture = fixtures[id];
      expect(fixture, `no fixture for route ${id}`).toBeDefined();
      if (fixture === "websocket") {
        const path = route.path.replace(":id", a.id);
        expect(await upgrades(`ws://127.0.0.1:${port}${path}`), id).toBe(true);
        continue;
      }
      const path = route.path.replace(
        /:(\w+)/g,
        (_m, name: string) => fixture.params?.[name] ?? "",
      );
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: route.method,
        headers: { "content-type": "application/json", ...authHeaders },
        ...(fixture.body ? { body: JSON.stringify(fixture.body) } : {}),
      });
      expect([404, 405], `${id} ${route.method} ${path} -> ${res.status}`).not.toContain(
        res.status,
      );
      expect(res.status, id).toBeLessThan(500);
    }
  });
});
