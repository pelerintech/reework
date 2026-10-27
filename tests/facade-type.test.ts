import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type, definePlugin, defineTool } from "@reework/core";
import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";

describe("plugins build tool schemas from @reework/core alone", () => {
  it("validates and passes arguments typed with Type", async () => {
    const double = definePlugin("math", () => ({
      tools: [
        defineTool({
          name: "double",
          description: "Double a number.",
          parameters: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
          async execute(args) {
            return `result=${args.n * 2}`;
          },
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("double", { n: 2 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const agent = await startTestAgent(
      testDefinition({ plugins: [{ plugin: double, config: {} }] }),
      {
        models: faux.models,
      },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "double 2", { wait: true });
    expect(JSON.stringify((await agent.host.readConversation(id)).entries)).toContain("result=4");
  });
});
