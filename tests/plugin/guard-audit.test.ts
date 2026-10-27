import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm } from "../support/fake-llm.ts";
import { auditPlugin, guardPlugin } from "./fixtures/guard-audit.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

function echoPlugin(runs: string[]) {
  return definePlugin("tools", () => ({
    tools: [
      defineTool({
        name: "echo",
        description: "Echo.",
        parameters: Type.Object({ text: Type.String() }),
        async execute(args) {
          runs.push(args.text);
          return `echo:${args.text}`;
        },
      }),
    ],
  }));
}

interface Started {
  readonly llm: FakeLlm;
  readonly runs: string[];
  readonly events: string[];
  readonly submit: (text: string) => Promise<void>;
}

/** An agent with the echo tool plus the given guard/audit order. */
async function startWith(order: Array<"guard" | "audit">): Promise<Started> {
  const llm = await startFakeLlm();
  const runs: string[] = [];
  const events: string[] = [];
  const byName = { guard: guardPlugin(events), audit: auditPlugin(events) } as const;
  const plugins = order.map((o) => ({ plugin: byName[o], config: {} }));
  const def: AgentDefinition = {
    name: "h",
    model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
    plugins: [...plugins, { plugin: echoPlugin(runs), config: {} }],
    channels: [],
    mission: { role: "r" },
  };
  const agent = await startTestAgent(def, { models: undefined });
  const { id } = await agent.host.createConversation();
  const submit = (text: string) => agent.host.submitInput(id, text, { wait: true });
  return { llm, runs, events, submit: (t: string) => submit(t).then(() => undefined) };
}

describe("guard and audit plugins prove order and memo", () => {
  it("guard-then-audit: the audit sees the blocked call via its afterTool", async () => {
    const { llm, runs, events, submit } = await startWith(["guard", "audit"]);
    llm.script({ toolCall: { name: "echo", args: { text: "block me" } } }, { text: "ok" });
    await submit("go");
    expect(runs).toEqual([]); // the tool never ran
    expect(events).toContain("guard:block");
    // guard blocked first, so the audit's beforeTool does not run, but its
    // afterTool receives the blocked result.
    expect(events).not.toContain("tool-before:echo");
    expect(events).toContain("tool-after:echo:blocked");
  });

  it("audit-then-guard: the audit sees the call via its beforeTool", async () => {
    const { llm, runs, events, submit } = await startWith(["audit", "guard"]);
    llm.script({ toolCall: { name: "echo", args: { text: "block me" } } }, { text: "ok" });
    await submit("go");
    expect(runs).toEqual([]); // the tool never ran
    expect(events).toContain("guard:block");
    expect(events).toContain("tool-before:echo");
    expect(events).not.toContain("tool-after:echo:blocked");
  });

  it("a rewrite beforeTool still lets the tool run, and afterTool chains", async () => {
    const { llm, runs, events, submit } = await startWith(["guard", "audit"]);
    llm.script({ toolCall: { name: "echo", args: { text: "rewrite me" } } }, { text: "ok" });
    await submit("go");
    expect(runs).toEqual(["rewritten"]);
    expect(events).toContain("guard:rewrite");
    expect(events).toContain("tool-before:echo");
    expect(events).toContain("tool-after:echo:ok");
  });

  it("a beforeModelRequest using ctx.memo computes once across a retried request", async () => {
    const llm = await startFakeLlm();
    let computeCount = 0;
    const plugin = definePlugin("memo", () => ({
      hooks: {
        async beforeModelRequest(_input, ctx) {
          await ctx.memo("recall", async () => {
            computeCount += 1;
            return "value";
          });
          return undefined;
        },
      },
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
    // A transient 5xx, then success, so the request is retried.
    llm.script({ status: 500 }, { text: "ok" });
    await agent.host.submitInput(id, "go", { wait: true });
    expect(llm.requests.length).toBeGreaterThanOrEqual(2); // it really was retried
    expect(computeCount).toBe(1); // memo returned the cached value on the retry
  });
});
