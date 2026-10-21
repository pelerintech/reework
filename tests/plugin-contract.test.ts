import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, defineTool } from "@reework/core";
import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
  async execute(args) {
    return { output: [{ type: "text", text: `echo:${args.text}` }] };
  },
});

describe("plugin contract", () => {
  it("a plugin's tool is callable by an agent started with startAgent", async () => {
    const echoPlugin = definePlugin("echo", () => ({ tools: [echo] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin: echoPlugin, config: {} }] }),
      { models: faux.models },
    );
    const conversation = await agent.host.createConversation();
    const reply = await agent.host.submitInput(conversation.id, "go", { wait: true });

    expect(reply.message?.content).toEqual([{ type: "text", text: "done" }]);
    const read = await agent.host.readConversation(conversation.id);
    expect(JSON.stringify(read.entries)).toContain("echo:hi");
  });

  it("builds each plugin from its declared config", async () => {
    const greeter = definePlugin("greeter", (config: { greeting: string }) => ({
      tools: [
        defineTool({
          name: "greet",
          description: "Greet.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            return { output: [{ type: "text", text: `${config.greeting}, world` }] };
          },
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("greet", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin: greeter, config: { greeting: "hola" } }] }),
      { models: faux.models },
    );
    const conversation = await agent.host.createConversation();
    await agent.host.submitInput(conversation.id, "go", { wait: true });
    const read = await agent.host.readConversation(conversation.id);
    expect(JSON.stringify(read.entries)).toContain("hola, world");
  });

  it("stops startup naming the plugin when its factory rejects the config", async () => {
    const strict = definePlugin("strict", (config: { token?: string }) => {
      if (!config.token) throw new Error("token is required");
      return {};
    });
    await expect(
      startTestAgent(testDefinition({ plugins: [{ plugin: strict, config: {} }] })),
    ).rejects.toThrow(/plugin "strict" failed: token is required/);
  });

  it("runs setup for plugins and channels after the engine opens, with host and storage", async () => {
    const created: string[] = [];
    const notes: unknown[] = [];
    const recorder = (label: string) =>
      definePlugin(label, (_config: { tag: string }) => ({
        async setup(ctx) {
          const conversation = await ctx.host.createConversation();
          created.push(conversation.id);
          const Note = ctx.storage.defineDoc<{ by: string }>({
            kind: `test.note.${label}`,
            version: 1,
            scope: "session",
            initial: () => ({ by: "" }),
          });
          await ctx.storage.commit(async (tx) => {
            (await tx.doc(Note)).by = ctx.config.tag;
          });
          notes.push(await ctx.storage.readSession(Note));
        },
      }));

    await startTestAgent(
      testDefinition({
        plugins: [{ plugin: recorder("cap"), config: { tag: "plugin" } }],
        channels: [{ plugin: recorder("chan"), config: { tag: "channel" } }],
      }),
    );

    expect(created).toHaveLength(2);
    expect(notes).toEqual([{ by: "plugin" }, { by: "channel" }]);
  });
});
