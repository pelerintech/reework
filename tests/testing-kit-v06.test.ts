// The kit lists offered tools and helps with cases and files; imports only @reework/core and /testing.
import { describe, expect, it } from "vitest";
import { Type, defineAgent, definePlugin, defineTool } from "@reework/core";
import { addFile, offeredTools, startTestAgent, text } from "@reework/core/testing";

const plugin = definePlugin("ops", () => ({
  tools: [
    defineTool({
      name: "status",
      description: "Service status",
      parameters: Type.Object({}),
      execute: async () => "ok",
    }),
  ],
}));

const definition = defineAgent({
  name: "kit-v06",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "KIT_KEY" }, modelId: "m1" },
  models: {
    fast: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "KIT_KEY" }, modelId: "fast" },
  },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You help." },
});

describe("the v06 testing kit", () => {
  it("lists the tools offered to the model, including update_case", async () => {
    const test = await startTestAgent(definition);
    const { id } = await test.agent.host.createConversation();
    const tools = offeredTools(test, id);
    const names = tools.map((t) => t.name);
    expect(names).toContain("status");
    expect(names).toContain("update_case");
    const updateCase = tools.find((t) => t.name === "update_case");
    expect(updateCase?.parameters).toBeTruthy();
  });

  it("exposes a scripted model for every declared named model", async () => {
    const test = await startTestAgent(definition);
    expect(Object.keys(test.models)).toEqual(["fast"]);
    test.models.fast!.respond([text("fast answer")]);
  });

  it("uploads a file and reads a case through the host", async () => {
    const test = await startTestAgent(definition);
    const { id } = await test.agent.host.createConversation();
    const file = await addFile(test, id, { name: "a.txt", bytes: new TextEncoder().encode("hi") });
    expect(file.name).toBe("a.txt");
    expect(file.size).toBe(2);
    const c = await test.agent.host.getCase(id);
    expect(c.id).toBe(id);
  });
});
