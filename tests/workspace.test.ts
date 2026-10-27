import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { codingTools, definePlugin } from "@reework/core";
import {
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";

/** A workspace provider making one directory per conversation, holding note.txt = its key. */
function workspaces() {
  const root = mkdtempSync(join(tmpdir(), "reework-ws-"));
  const calls: { conversationId: string; key?: string }[] = [];
  const plugin = definePlugin("workspace", () => ({
    tools: codingTools(),
    workspace: {
      async create(conversation) {
        calls.push(conversation);
        const cwd = join(root, `c-${conversation.conversationId}`);
        mkdirSync(cwd, { recursive: true });
        writeFileSync(join(cwd, "note.txt"), `note for ${conversation.key ?? "none"}`);
        return { cwd };
      },
    },
  }));
  return { plugin, calls };
}

const readNote = () => [
  fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("read it"),
];

describe("per-conversation workspace", () => {
  it("gives each conversation's coding tools its own directory, created once per conversation", async () => {
    const { plugin, calls } = workspaces();
    const faux = fauxModels();
    faux.respond([...readNote(), ...readNote()]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });

    const a = await agent.host.createConversation({ key: "alert-a" });
    const b = await agent.host.createConversation({ key: "alert-b" });
    await agent.host.createConversation({ key: "alert-a" });
    await agent.host.submitInput(a.id, "read the note", { wait: true });
    await agent.host.submitInput(b.id, "read the note", { wait: true });

    expect(JSON.stringify((await agent.host.readConversation(a.id)).entries)).toContain(
      "note for alert-a",
    );
    expect(JSON.stringify((await agent.host.readConversation(b.id)).entries)).toContain(
      "note for alert-b",
    );
    expect(calls).toEqual([
      { conversationId: a.id, key: "alert-a" },
      { conversationId: b.id, key: "alert-b" },
    ]);
  });

  it("keeps a conversation's workspace across a restart without creating it again", async () => {
    const { plugin, calls } = workspaces();
    const storagePath = tmpStorage();
    const def = testDefinition({ plugins: [{ plugin, config: {} }] });
    const faux1 = fauxModels();
    faux1.respond(readNote());
    const first = await startTestAgent(def, { storagePath, models: faux1.models });
    const a = await first.host.createConversation({ key: "alert-a" });
    await first.host.submitInput(a.id, "read the note", { wait: true });
    untrack(first);
    await first.stop();

    const faux2 = fauxModels();
    faux2.respond([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("read it again"),
    ]);
    const second = await startTestAgent(def, { storagePath, models: faux2.models });
    await second.host.createConversation({ key: "alert-a" });
    await second.host.submitInput(a.id, "read it again", { wait: true });

    const results = JSON.stringify((await second.host.readConversation(a.id)).entries);
    expect(results.split("note for alert-a").length - 1).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(1);
  });

  it("stops startup when two plugins both provide workspaces", async () => {
    const one = workspaces().plugin;
    const other = definePlugin("other-workspace", () => ({
      workspace: { create: async () => ({ cwd: tmpdir() }) },
    }));
    await expect(
      startTestAgent(
        testDefinition({
          plugins: [
            { plugin: one, config: {} },
            { plugin: other, config: {} },
          ],
        }),
      ),
    ).rejects.toThrow(/workspace.*"workspace".*"other-workspace"/);
  });

  it("without a provider, coding tools report a missing environment and the run carries on", async () => {
    const tools = definePlugin("tools", () => ({ tools: codingTools() }));
    const faux = fauxModels();
    faux.respond(readNote());
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin: tools, config: {} }] }),
      {
        models: faux.models,
      },
    );
    const { id } = await agent.host.createConversation();
    const reply = await agent.host.submitInput(id, "read the note", { wait: true });

    expect(reply.message?.content).toEqual([{ type: "text", text: "read it" }]);
    expect(JSON.stringify((await agent.host.readConversation(id)).entries)).toContain(
      "No execution environment",
    );
  });
});
