// Files arrive with input: the model's request names them; a foreign file is refused.
import { afterEach, describe, expect, it } from "vitest";
import { startAgent } from "@reework/core";
import type { AgentDefinition, RunningAgent } from "@reework/core";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm } from "../support/fake-llm.ts";
import { authedApp, TEST_TOKEN, testDefinition, tmpStorage } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const PDF = new TextEncoder().encode("%PDF-1.4 hello");

async function start(): Promise<{ agent: RunningAgent; llm: FakeLlm }> {
  const llm = await startFakeLlm();
  process.env["K"] = "k";
  const def: AgentDefinition = testDefinition({
    model: { provider: { baseUrl: llm.url, apiKeyEnv: "K" }, modelId: "m1" },
  });
  const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: TEST_TOKEN } });
  running.push({ dispose: () => agent.stop() });
  return { agent, llm };
}

describe("files with input", () => {
  it("names the file in the model's input (host and HTTP)", async () => {
    const { agent, llm } = await start();
    const app = authedApp(agent);
    const { id } = await agent.host.createConversation();
    const file = await agent.host.addFile(id, {
      name: "a.pdf",
      mimeType: "application/pdf",
      bytes: PDF,
    });
    const line = `Attached: a.pdf (application/pdf, ${PDF.length} bytes, file ${file.id})`;

    llm.script({ text: "ok" });
    await agent.host.submitInput(id, "see attached", { files: [file.id], wait: true });
    expect(JSON.stringify(llm.requests[0]!.body)).toContain(line);

    llm.script({ text: "ok again" });
    const res = await app.request(`/conversations/${id}/messages?wait=true`, {
      method: "POST",
      body: JSON.stringify({ content: "see attached", files: [file.id] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(llm.requests[1]!.body)).toContain(line);
  });

  it("refuses a file from another conversation and submits nothing", async () => {
    const { agent, llm } = await start();
    const app = authedApp(agent);
    const a = await agent.host.createConversation();
    const b = await agent.host.createConversation();
    const file = await agent.host.addFile(a.id, { name: "a.pdf", bytes: PDF });

    await expect(agent.host.submitInput(b.id, "x", { files: [file.id] })).rejects.toThrow(/file/);
    const res = await app.request(`/conversations/${b.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "x", files: [file.id] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(llm.requests.length).toBe(0);
    expect((await agent.host.readConversation(b.id)).entries.length).toBe(0);
  });
});
