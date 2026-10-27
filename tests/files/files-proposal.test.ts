// Files on proposals: a gate attaches a file; a foreign file fails the gate.
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin, gatedAction, Type } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import {
  authedApp,
  fauxModels,
  startTestAgent,
  TEST_TOKEN,
  testDefinition,
} from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const PDF = new TextEncoder().encode("%PDF-1.4 hello");

const plugin = definePlugin("ops", () => ({
  tools: [
    gatedAction({
      name: "attach",
      parameters: Type.Object({ fileId: Type.String() }),
      gate: (args) => ({
        title: "Review the file",
        options: [{ id: "ok", label: "OK" }],
        attachments: [{ kind: "file", fileId: args.fileId }],
      }),
      run: async () => "ok",
    }),
  ],
}));

describe("files on proposals", () => {
  it("carries the file attachment through host, HTTP and client", async () => {
    const faux = fauxModels();
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const app = authedApp(agent);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    const { id } = await agent.host.createConversation();
    const file = await agent.host.addFile(id, {
      name: "a.pdf",
      mimeType: "application/pdf",
      bytes: PDF,
    });

    faux.respond([toolCall("attach", { fileId: file.id }), text("done")]);
    await agent.host.submitInput(id, "attach", { wait: true });

    const [proposal] = await agent.host.listProposals({ conversationId: id });
    expect(proposal!.attachments?.[0]).toMatchObject({
      kind: "file",
      fileId: file.id,
      name: "a.pdf",
      mimeType: "application/pdf",
      size: PDF.length,
    });

    const http = await app.request(`/conversations/${id}/proposals`);
    const httpProposal = (
      (await http.json()) as { proposals: { attachments?: { kind: string }[] }[] }
    ).proposals[0];
    expect(httpProposal!.attachments?.[0]?.kind).toBe("file");

    const viaClient = await client.listProposals();
    expect(viaClient[0]!.attachments?.[0]?.kind).toBe("file");
  });

  it("fails the gate and opens no proposal for a foreign file", async () => {
    const faux = fauxModels();
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const a = await agent.host.createConversation();
    const b = await agent.host.createConversation();
    const file = await agent.host.addFile(a.id, { name: "a.pdf", bytes: PDF });

    faux.respond([toolCall("attach", { fileId: file.id }), text("done")]);
    await agent.host.submitInput(b.id, "attach", { wait: true });
    expect((await agent.host.listProposals({ conversationId: b.id })).length).toBe(0);
    expect((await agent.host.listProposals({ conversationId: a.id })).length).toBe(0);
  });
});
