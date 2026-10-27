// Files in the TUI: a file attachment on a card, :files, and :save.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePlugin, gatedAction, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { KEYS, startTui } from "./support/tui.tsx";

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

const definition: AgentDefinition = {
  name: "files-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You help." },
};

describe("the TUI shows and saves files", () => {
  it("shows a file attachment's name, type and size, and saves it with :files/:save", async () => {
    const tui = await startTui(definition, { noticeMs: 30_000 });
    const { id } = await tui.agent.host.createConversation({ key: "file-case" });
    const file = await tui.agent.host.addFile(id, {
      name: "a.pdf",
      mimeType: "application/pdf",
      bytes: PDF,
    });
    tui.model.respond([toolCall("attach", { fileId: file.id }), text("asked")]);
    await tui.agent.host.submitInput(id, "attach", { wait: true });

    const card = await tui.waitForFrame("Review the file");
    expect(card).toContain("a.pdf");
    expect(card).toContain("application/pdf");
    expect(card).toContain(`${PDF.length} bytes`);

    await tui.type(KEYS.enter);
    await tui.waitForFrame("conversation file-case");
    await tui.send(":files");
    const listed = await tui.waitForFrame("1. a.pdf");
    expect(listed).toContain("application/pdf");

    const dir = mkdtempSync(join(tmpdir(), "reework-save-"));
    await tui.send(`:save 1 ${dir}`);
    await tui.waitForFrame(`saved ${join(dir, "a.pdf")}`);
    expect(new Uint8Array(readFileSync(join(dir, "a.pdf")))).toEqual(PDF);
  });
});
