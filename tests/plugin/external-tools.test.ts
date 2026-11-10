// External tools: a tool declares that its output is outside content, and the
// result-level flag marks one result; both reach hooks and later model requests.
import { afterEach, describe, expect, it } from "vitest";
import { codingTools, definePlugin, defineTool, gatedAction, Type } from "@reework/core";
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

  it("lets an unflagged tool mark one result external", async () => {
    const seen: (boolean | undefined)[] = [];
    const read = definePlugin("reader", () => ({
      tools: [
        defineTool({
          name: "read",
          description: "Read a source.",
          parameters: Type.Object({ outside: Type.Boolean() }),
          async execute(args) {
            return args.outside ? { output: "x", external: true } : "plain";
          },
        }),
      ],
    }));
    const observer = definePlugin("observer", () => ({
      hooks: {
        async afterTool(_call, result) {
          seen.push(result.external);
        },
      },
    }));
    const { test, id } = await start([{ plugin: read }, { plugin: observer }]);
    test.model.respond([
      toolCall("read", { outside: true }),
      toolCall("read", { outside: false }),
      text("done"),
    ]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen).toEqual([true, undefined]);
  });

  it("leaves plain tools, gated actions and coding tools unflagged", async () => {
    const seen: { call?: boolean; result?: boolean }[] = [];
    const source = definePlugin("plain-source", () => ({
      tools: [
        defineTool({
          name: "plain",
          description: "Return text.",
          parameters: Type.Object({}),
          async execute() {
            return "text";
          },
        }),
        gatedAction({
          name: "apply",
          gate: { title: "Apply?" },
          async run() {
            return "applied";
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
    const { test, id } = await start([{ plugin: source }, { plugin: observer }]);
    test.model.respond([toolCall("plain", {}), toolCall("apply", {}), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen).toEqual([
      { call: false, result: undefined },
      { call: false, result: undefined },
    ]);
    // The coding tools are framework-owned and never external.
    expect(codingTools().some((tool) => tool.external === true)).toBe(false);
  });

  it("keeps the flag sticky through the hook chain", async () => {
    const seen: { name: string; output: string; external?: boolean }[] = [];
    const source = definePlugin("source", () => ({
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
        defineTool({
          name: "plain",
          description: "Return text.",
          parameters: Type.Object({}),
          async execute() {
            return "text";
          },
        }),
      ],
    }));
    const first = definePlugin("first", () => ({
      hooks: {
        async afterTool(call, result) {
          if (call.name === "lookup") return { output: "changed" };
          if (call.name === "plain") return { output: result.output, external: true };
          return undefined;
        },
      },
    }));
    const second = definePlugin("second", () => ({
      hooks: {
        async afterTool(call, result) {
          seen.push({ name: call.name, output: result.output, external: result.external });
        },
      },
    }));
    const { test, id } = await start([{ plugin: source }, { plugin: first }, { plugin: second }]);
    test.model.respond([toolCall("lookup", {}), toolCall("plain", {}), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen).toEqual([
      { name: "lookup", output: "changed", external: true },
      { name: "plain", output: "text", external: true },
    ]);
  });

  it("does not mark a blocked call's result external", async () => {
    const seen: { call?: boolean; result?: boolean }[] = [];
    const source = definePlugin("source", () => ({
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
    const blocker = definePlugin("blocker", () => ({
      hooks: {
        async beforeTool(call) {
          if (call.name === "lookup") return { block: "not allowed" };
          return undefined;
        },
      },
    }));
    const observer = definePlugin("observer", () => ({
      hooks: {
        async afterTool(call, result) {
          seen.push({ call: call.external, result: result.external });
        },
      },
    }));
    const { test, id } = await start([
      { plugin: source },
      { plugin: blocker },
      { plugin: observer },
    ]);
    test.model.respond([toolCall("lookup", {}), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(seen).toEqual([{ call: true, result: undefined }]);
  });

  it("lets a hook mark a blocked result external", async () => {
    const marked: (boolean | undefined)[] = [];
    const seen: (boolean | undefined)[] = [];
    const source = definePlugin("source", () => ({
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
    const blocker = definePlugin("blocker", () => ({
      hooks: {
        async beforeTool(call) {
          if (call.name === "lookup") return { block: "not allowed" };
          return undefined;
        },
      },
    }));
    const marker = definePlugin("marker", () => ({
      hooks: {
        async afterTool(call, result) {
          if (call.name !== "lookup") return undefined;
          marked.push(result.external);
          return { ...result, external: true };
        },
      },
    }));
    const observer = definePlugin("observer", () => ({
      hooks: {
        async afterTool(_call, result) {
          seen.push(result.external);
        },
      },
    }));
    const { test, id } = await start([
      { plugin: source },
      { plugin: blocker },
      { plugin: marker },
      { plugin: observer },
    ]);
    test.model.respond([toolCall("lookup", {}), text("done")]);
    await test.agent.host.submitInput(id, "go", { wait: true });

    expect(marked).toEqual([undefined]);
    expect(seen).toEqual([true]);
  });
});
