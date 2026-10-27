import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition, PluginHooks } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

interface Harness {
  readonly llm: FakeLlm;
  readonly id: string;
  readonly submit: (text: string) => Promise<void>;
}

/** An agent whose `echo` tool records the args it actually ran with. */
async function agentWith(
  hooks: PluginHooks,
  onRun: (args: { text: string }) => void,
): Promise<Harness> {
  const llm = await startFakeLlm();
  const plugin = definePlugin("hooky", () => ({
    tools: [
      defineTool({
        name: "echo",
        description: "Echo.",
        parameters: Type.Object({ text: Type.String() }),
        async execute(args) {
          onRun(args);
          return `echo:${args.text}`;
        },
      }),
    ],
    hooks,
  }));
  const def: AgentDefinition = {
    name: "h",
    model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "r" },
  };
  const agent = await startTestAgent(def, { models: undefined });
  const { id } = await agent.host.createConversation();
  const submit = (text: string) => agent.host.submitInput(id, text, { wait: true });
  return {
    llm,
    id,
    submit: (text: string) => submit(text).then(() => undefined),
  };
}

/** Does any recorded request carry the given JSON-ish substring? */
function issued(llm: FakeLlm, text: string): boolean {
  return llm.requests.some((req) => JSON.stringify(req.body).includes(text));
}

describe("plugin hook semantics: tool hooks", () => {
  it("does not run the tool when beforeTool blocks", async () => {
    const runs: string[] = [];
    const { llm, submit } = await agentWith(
      {
        async beforeTool({ name }) {
          if (name === "echo") return { block: "blocked by policy" };
          return undefined;
        },
      },
      (args) => runs.push(args.text),
    );
    llm.script({ toolCall: { name: "echo", args: { text: "hello" } } }, { text: "ok" });
    await submit("go");
    expect(runs).toEqual([]);
  });

  it("runs the tool with beforeTool-rewritten args", async () => {
    const runs: string[] = [];
    const { llm, submit } = await agentWith(
      {
        async beforeTool({ name }) {
          if (name === "echo") return { args: { text: "rewritten" } };
          return undefined;
        },
      },
      (args) => runs.push(args.text),
    );
    llm.script({ toolCall: { name: "echo", args: { text: "hello" } } }, { text: "ok" });
    await submit("go");
    expect(runs).toEqual(["rewritten"]);
  });

  it("blocks with the error message when beforeTool throws", async () => {
    const runs: string[] = [];
    const { submit } = await agentWith(
      {
        async beforeTool() {
          throw new Error("exploded in beforeTool");
        },
      },
      (args) => runs.push(args.text),
    );
    await submit("go");
    expect(runs).toEqual([]);
  });

  it("lets afterTool replace the tool result the model sees", async () => {
    const runs: string[] = [];
    const { llm, submit } = await agentWith(
      {
        async afterTool(_call, result) {
          return { output: result.output.replace("secret", "[redacted]") };
        },
      },
      (args) => runs.push(args.text),
    );
    llm.script({ toolCall: { name: "echo", args: { text: "secret" } } }, { text: "ok" });
    await submit("go");
    expect(runs).toEqual(["secret"]);
    expect(issued(llm, "[redacted]")).toBe(true);
    expect(issued(llm, "echo:secret")).toBe(false);
  });
});
