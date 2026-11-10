// External tools: a tool declares that its output is outside content, and the
// result-level flag marks one result; both reach hooks and later model requests.
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition, ReeworkPlugin } from "@reework/core";
import { startTestAgent, text, toolCall } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";

const started: TestAgent[] = [];
afterEach(async () => {
  while (started.length > 0)
    await started
      .pop()!
      .dispose()
      .catch(() => {});
});

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "external-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "r" },
  };
}

async function start(plugins: readonly { plugin: ReeworkPlugin; config?: unknown }[]) {
  const test = await startTestAgent(
    definition(plugins.map(({ plugin, config }) => ({ plugin, config }))),
  );
  started.push(test);
  const { id } = await test.agent.host.createConversation();
  return { test, id };
}

describe("external tools", () => {
  it("reaches hooks as external when the tool is flagged", async () => {
    const seen: { call?: boolean; result?: boolean }[] = [];
    const lookup = definePlugin("lookup-source", () => ({
      tools: [
        defineTool({
          name: "lookup",
          description: "Read outside content.",
          external: true,
          parameters: Type.Object({}),
          async execute() {
            return "data";
          },
        }),
      ],
    }));
    const observer = definePlugin("observer", () => ({
      hooks: {
        async afterTool(call, result) {
          seen.push({ call: call.external, result: result.external });
        },
      },
    }));
    const { test, id } = await start([{ plugin: lookup }, { plugin: observer }]);
    test.model.respond([toolCall("lookup", {}), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen).toEqual([{ call: true, result: true }]);
  });
});
