import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
const KEY_ENV = "K";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});
import { Type } from "@reework/core";
import { codingTools, definePlugin, section } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent as startHarnessAgent } from "../support/agent.ts";
import { startTestAgent, text, toolCall, waitFor } from "@reework/core/testing";
import { startFakeLlm } from "../support/fake-llm.ts";

const running: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("sections and the tool value boundary", () => {
  it("renders a section with that conversation's id into the model's request", async () => {
    const llm = await startFakeLlm();
    const note = definePlugin("note", () => ({
      sections: [section("note", ({ conversationId }) => `note for ${conversationId}`)],
    }));
    const def: AgentDefinition = {
      name: "sections",
      model: { provider: { baseUrl: llm.url, apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [{ plugin: note, config: {} }],
      channels: [],
      mission: { role: "r" },
    };
    const test = await startHarnessAgent(def, { models: undefined });
    const { id } = await test.host.createConversation();
    await test.host.submitInput(id, "hi", { wait: true });

    const request = llm.requests[0];
    const system = request.body.messages as { role: string; content: unknown }[];
    const rendered = JSON.stringify(system);
    expect(rendered).toContain(`note for ${id}`);
  });

  it("stops startup naming the plugin and tool when a tool is not a reework tool", async () => {
    const bad = definePlugin("bad", () => ({
      tools: [{ name: "sneaky", description: "d", parameters: Type.Object({}) } as never],
    }));
    await expect(
      startTestAgent({
        name: "bad",
        model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
        plugins: [{ plugin: bad, config: {} }],
        channels: [],
        mission: { role: "r" },
      }),
    ).rejects.toThrow(/plugin "bad".*"sneaky"/);
  });

  it("accepts the reework coding tools and they act in the workspace", async () => {
    const tools = definePlugin("code", () => ({
      tools: codingTools(),
      workspace: {
        async create(conversation) {
          const cwd = mkdtempSync(join(tmpdir(), "reework-code-"));
          writeFileSync(join(cwd, "n.txt"), `hi ${conversation.key ?? ""}`);
          return { cwd };
        },
      },
    }));
    const test = await startTestAgent({
      name: "code",
      model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [{ plugin: tools, config: {} }],
      channels: [],
      mission: { role: "r" },
    });
    running.push(test);
    const { id } = await test.agent.host.createConversation({ key: "k1" });
    test.model.respond([toolCall("read", { path: "n.txt" }), text("done")]);
    await test.agent.host.submitInput(id, "read the note", { wait: true });
    await waitFor(async () =>
      JSON.stringify((await test.agent.host.readConversation(id)).entries).includes("hi k1"),
    );
    const read = JSON.stringify((await test.agent.host.readConversation(id)).entries);
    expect(read).toContain("hi k1");
  });
});
