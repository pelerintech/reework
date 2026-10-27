// `maxConcurrentRequests` bounds the load an agent puts on its endpoint: extra
// requests wait for a free slot; nothing is dropped.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentModel } from "@reework/core";
import { startTestAgent, testDefinition } from "./support/agent.ts";
import { startFakeLlm } from "./support/fake-llm.ts";
import type { FakeLlm } from "./support/fake-llm.ts";
import { eventually } from "./support/wait.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "sk-test";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

const noRetry = {
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  stream: { maxRetries: 0 },
};

async function agentOn(
  llm: FakeLlm,
  limits: Partial<AgentModel>,
  stream: { timeoutMs?: number } = {},
) {
  return startTestAgent(
    testDefinition({
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1", ...limits },
    }),
    { models: undefined, settings: { ...noRetry, stream: { ...noRetry.stream, ...stream } } },
  );
}

async function askAll(agent: Awaited<ReturnType<typeof agentOn>>, count: number) {
  const ids = await Promise.all(
    Array.from({ length: count }, async () => (await agent.host.createConversation()).id),
  );
  return Promise.all(ids.map((id) => agent.host.submitInput(id, "go", { wait: true })));
}

describe("endpoint concurrency", () => {
  it("keeps at most maxConcurrentRequests in flight and answers everyone", async () => {
    const llm = await startFakeLlm();
    llm.script(...[1, 2, 3].map((n) => ({ text: `answer ${n}`, delayMs: 200 })));
    const agent = await agentOn(llm, { maxConcurrentRequests: 2 });
    const answers = await askAll(agent, 3);
    expect(answers.every((a) => a.message !== undefined)).toBe(true);
    expect(llm.load.peak).toBe(2);
  });

  it("does not delay requests without a limit", async () => {
    const llm = await startFakeLlm();
    llm.script(...[1, 2, 3].map((n) => ({ text: `answer ${n}`, delayMs: 600 })));
    const agent = await agentOn(llm, {});
    await askAll(agent, 3);
    expect(llm.load.peak).toBe(3);
  });

  it("frees the slot of a failed request", async () => {
    const llm = await startFakeLlm();
    llm.script({ status: 500 }, { text: "second works" });
    const agent = await agentOn(llm, { maxConcurrentRequests: 1 });
    const [a, b] = await Promise.all([
      agent.host.createConversation(),
      agent.host.createConversation(),
    ]);
    await agent.host.submitInput(a.id, "fails", { wait: true });
    const answer = await agent.host.submitInput(b.id, "go", { wait: true });
    expect(JSON.stringify(answer.message)).toContain("second works");
  });

  it("frees the slot of an aborted run", async () => {
    const llm = await startFakeLlm();
    llm.script({ text: "slow", delayMs: 5_000 }, { text: "next works" });
    const agent = await agentOn(llm, { maxConcurrentRequests: 1 });
    const [a, b] = await Promise.all([
      agent.host.createConversation(),
      agent.host.createConversation(),
    ]);
    await agent.host.submitInput(a.id, "slow one");
    await eventually(() => llm.load.inFlight === 1);
    const waiting = agent.host.submitInput(b.id, "go", { wait: true });
    await agent.host.abort(a.id);
    const answer = await waiting;
    expect(JSON.stringify(answer.message)).toContain("next works");
  });

  it("does not count the wait for a slot against the stream timeout", async () => {
    const llm = await startFakeLlm();
    // Each request answers well within the timeout; the third waits ~600 ms for its slot,
    // which (were it counted) would exceed the 500 ms stream timeout.
    llm.script(...[1, 2, 3].map((n) => ({ text: `answer ${n}`, delayMs: 300 })));
    const agent = await agentOn(llm, { maxConcurrentRequests: 1 }, { timeoutMs: 500 });
    const answers = await askAll(agent, 3);
    expect(answers.every((a) => a.message !== undefined)).toBe(true);
    expect(llm.load.peak).toBe(1);
  });
});
