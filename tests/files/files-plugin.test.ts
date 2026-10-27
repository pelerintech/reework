// Plugins read and add files through their tool/hook context; setup reaches files through host.
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { FileRecord } from "@reework/types";
import { text, toolCall } from "@reework/core/testing";
import { fauxModels, startTestAgent, testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const enc = (s: string) => new TextEncoder().encode(s);

describe("plugins read and add files", () => {
  it("reads an uploaded file and adds a derived file, in this case only", async () => {
    const plugin = definePlugin("files", () => ({
      tools: [
        defineTool({
          name: "derive",
          description: "read and derive",
          parameters: Type.Object({ fileId: Type.String() }),
          async execute(args, ctx) {
            const { bytes } = await ctx.files.read(args.fileId);
            const added = await ctx.files.add({
              name: "derived.txt",
              mimeType: "text/plain",
              bytes: enc("derived!"),
            });
            return `read:${bytes.length}:added:${added.id}:source:${added.source}`;
          },
        }),
      ],
    }));
    const faux = fauxModels();
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    const input = await agent.host.addFile(id, { name: "input.txt", bytes: enc("hello") });
    const other = await agent.host.createConversation();

    faux.respond([toolCall("derive", { fileId: input.id }), text("done")]);
    await agent.host.submitInput(id, "derive", { wait: true });

    const files = await agent.host.listFiles(id);
    expect(files.map((f) => [f.name, f.source])).toEqual([
      ["input.txt", "upload"],
      ["derived.txt", "plugin"],
    ]);
    expect((await agent.host.listFiles(other.id)).length).toBe(0);
    const transcript = JSON.stringify(await agent.host.readConversation(id));
    expect(transcript).toContain("read:5");
    expect(transcript).toContain("source:plugin");
  });

  it("ctx.files.add over maxBytes throws", async () => {
    const plugin = definePlugin("files", () => ({
      tools: [
        defineTool({
          name: "bigadd",
          description: "add a big file",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            try {
              await ctx.files.add({
                name: "big.bin",
                mimeType: "application/octet-stream",
                bytes: new Uint8Array(10),
              });
              return "added";
            } catch (error) {
              return `err:${(error as Error).message}`;
            }
          },
        }),
      ],
    }));
    const faux = fauxModels();
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin, config: {} }], files: { maxBytes: 5 } }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.addFile(id, { name: "small.txt", bytes: enc("abc") });
    faux.respond([toolCall("bigadd"), text("done")]);
    await agent.host.submitInput(id, "go", { wait: true });
    const transcript = JSON.stringify(await agent.host.readConversation(id));
    expect(transcript).toMatch(/too large/);
    expect((await agent.host.listFiles(id)).map((f) => f.name)).toEqual(["small.txt"]);
  });

  it("setup reaches files through host", async () => {
    let setupFile: FileRecord | undefined;
    let setupConversation: string | undefined;
    const plugin = definePlugin("files", () => ({
      async setup({ host }) {
        const c = await host.createConversation({ key: "setup-case" });
        setupConversation = c.id;
        setupFile = await host.addFile(c.id, {
          name: "setup.txt",
          mimeType: "text/plain",
          bytes: enc("setup"),
          source: "plugin",
        });
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    expect(setupFile?.source).toBe("plugin");
    expect((await agent.host.listFiles(setupConversation!)).map((f) => f.name)).toEqual([
      "setup.txt",
    ]);
  });
});
