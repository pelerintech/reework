import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startAgent } from "@reework/core";
import { startFakeLlm } from "../support/fake-llm.ts";
import { offeredTools } from "../support/fake-llm.ts";
import { testDefinition, tmpStorage } from "../support/agent.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("the update_case model tool", () => {
  it("is offered by default, and a scripted call sets the case stage and summary", async () => {
    const llm = await startFakeLlm();
    const def: AgentDefinition = {
      ...testDefinition(),
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
    };
    const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
    running.push({ dispose: () => agent.stop() });
    const { id } = await agent.host.createConversation();
    llm.script(
      { toolCall: { name: "update_case", args: { stage: "analyzing", summary: "looking" } } },
      { text: "done" },
    );
    await agent.host.submitInput(id, "go", { wait: true });
    expect(offeredTools(llm.requests[0])).toContain("update_case");
    const c = await agent.host.getCase(id);
    expect(c.stage).toBe("analyzing");
    expect(c.summary).toBe("looking");
  });

  it("cases.modelTool.fields narrows the schema and rejects other fields", async () => {
    const llm = await startFakeLlm();
    const def: AgentDefinition = {
      ...testDefinition(),
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      cases: { modelTool: { fields: ["stage"] } },
    };
    const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
    running.push({ dispose: () => agent.stop() });
    const { id } = await agent.host.createConversation();
    llm.script({ toolCall: { name: "update_case", args: { summary: "nope" } } }, { text: "done" });
    await agent.host.submitInput(id, "go", { wait: true });
    // The schema only lists `stage`; `summary` is not an offered field.
    const tools = (llm.requests[0].body.tools ?? []) as {
      function?: { name: string; parameters?: { properties?: Record<string, unknown> } };
    }[];
    const update = tools.find((t) => t.function?.name === "update_case");
    expect(update?.function?.parameters?.properties).toHaveProperty("stage");
    expect(update?.function?.parameters?.properties).not.toHaveProperty("summary");
  });

  it("cases.modelTool:false stops the model being offered it", async () => {
    const llm = await startFakeLlm();
    const def: AgentDefinition = {
      ...testDefinition(),
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      cases: { modelTool: false },
    };
    const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
    running.push({ dispose: () => agent.stop() });
    const { id } = await agent.host.createConversation();
    llm.script({ text: "done" });
    await agent.host.submitInput(id, "go", { wait: true });
    expect(offeredTools(llm.requests[0])).not.toContain("update_case");
  });

  it("a plugin beforeTool can see and block update_case", async () => {
    const llm = await startFakeLlm();
    const guard = definePlugin("guard", () => ({
      hooks: {
        async beforeTool({ name }) {
          if (name === "update_case") return { block: "no case edits" };
          return undefined;
        },
      },
    }));
    const def: AgentDefinition = {
      ...testDefinition(),
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      plugins: [{ plugin: guard, config: {} }],
    };
    const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
    running.push({ dispose: () => agent.stop() });
    const { id } = await agent.host.createConversation();
    llm.script({ toolCall: { name: "update_case", args: { stage: "x" } } }, { text: "done" });
    await agent.host.submitInput(id, "go", { wait: true });
    const c = await agent.host.getCase(id);
    expect(c.stage).toBeUndefined(); // blocked: the case did not change.
  });
});
