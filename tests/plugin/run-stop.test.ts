// A plugin can stop a run cleanly before a model request: the run ends the way the
// tool-round budget ends it, no request is made, and the snapshot carries the notice.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, DeclaredModule } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

function stepTool() {
  return defineTool({
    name: "step",
    description: "One step",
    parameters: Type.Object({}),
    execute: async () => "stepped",
  });
}

function definition(llmUrl: string, plugins: DeclaredModule[]): AgentDefinition {
  return {
    name: "stopper",
    model: { provider: { baseUrl: llmUrl, apiKeyEnv: KEY_ENV }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You work in steps." },
  };
}

describe("stopping a run", () => {
  it("stops before the next model request and records the notice", async () => {
    const llm = await startFakeLlm();
    let requests = 0;
    const limiter = definePlugin("limiter", () => ({
      tools: [stepTool()],
      hooks: {
        async beforeModelRequest() {
          requests += 1;
          if (requests === 2) return { stop: "daily budget reached" };
        },
      },
    }));
    llm.script({ toolCall: { name: "step" } });
    const agent = await startTestAgent(definition(llm.url, [{ plugin: limiter, config: {} }]), {
      models: undefined,
    });
    const { id } = await agent.host.createConversation();

    await agent.host.submitInput(id, "work", { wait: true });

    expect(llm.requests).toHaveLength(1);
    const snapshot = await agent.host.snapshot(id);
    expect(snapshot.stopNotice).toEqual({
      plugin: "limiter",
      reason: "daily budget reached",
    });
    expect(snapshot.running).toBe(false);

    llm.script({ text: "fresh start" });
    const { message } = await agent.host.submitInput(id, "again", { wait: true });
    expect(JSON.stringify(message)).toContain("fresh start");
    expect(llm.requests).toHaveLength(2);
  });

  it("names the first stopping plugin and does not run the second's hook", async () => {
    const llm = await startFakeLlm();
    let limiterRequests = 0;
    const limiter = definePlugin("limiter", () => ({
      tools: [stepTool()],
      hooks: {
        async beforeModelRequest() {
          limiterRequests += 1;
          if (limiterRequests === 2) return { stop: "daily budget reached" };
        },
      },
    }));
    let brakeCalls = 0;
    const brake = definePlugin("brake", () => ({
      hooks: {
        async beforeModelRequest() {
          brakeCalls += 1;
          if (brakeCalls === 2) return { stop: "brake says no" };
        },
      },
    }));
    llm.script({ toolCall: { name: "step" } });
    const agent = await startTestAgent(
      definition(llm.url, [
        { plugin: limiter, config: {} },
        { plugin: brake, config: {} },
      ]),
      { models: undefined },
    );
    const { id } = await agent.host.createConversation();

    await agent.host.submitInput(id, "work", { wait: true });

    const snapshot = await agent.host.snapshot(id);
    expect(snapshot.stopNotice).toEqual({
      plugin: "limiter",
      reason: "daily budget reached",
    });
    expect(brakeCalls).toBe(1);
    expect(llm.requests).toHaveLength(1);
  });

  it("accepts an input submitted while the stop is applied and runs it fresh", async () => {
    const llm = await startFakeLlm();
    let requests = 0;
    let reachedStop!: () => void;
    const stopReached = new Promise<void>((resolve) => (reachedStop = resolve));
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => (releaseStop = resolve));
    const limiter = definePlugin("limiter", () => ({
      tools: [stepTool()],
      hooks: {
        async beforeModelRequest() {
          requests += 1;
          if (requests === 2) {
            reachedStop();
            await stopReleased;
            return { stop: "daily budget reached" };
          }
        },
      },
    }));
    llm.script({ toolCall: { name: "step" } });
    const agent = await startTestAgent(definition(llm.url, [{ plugin: limiter, config: {} }]), {
      models: undefined,
    });
    const { id } = await agent.host.createConversation();

    await agent.host.submitInput(id, "work");
    await stopReached;
    const queued = agent.host.submitInput(id, "queued during stop", { wait: true });
    llm.script({ text: "fresh start" });
    releaseStop();

    const { message } = await queued;
    expect(JSON.stringify(message)).toContain("fresh start");
    expect((await agent.host.snapshot(id)).stopNotice).toEqual({
      plugin: "limiter",
      reason: "daily budget reached",
    });
  });
});
