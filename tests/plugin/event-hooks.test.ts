// Event hooks: plugins learn about input after it is admitted, once per input, through
// a per-agent queue that never delays the caller.
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@reework/client";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition, GateDecision, PluginEventContext } from "@reework/core";
import { startTestAgent, text, toolCall, waitForProposal } from "@reework/core/testing";
import type { AgentHost } from "@reework/core";
import type { Proposal } from "@reework/types";
import { eventually } from "../support/wait.ts";

interface Seen {
  readonly input: { conversationId: string; submissionId: string; content: string; from?: unknown };
  readonly ctx: PluginEventContext;
}

function definition(plugin: ReturnType<typeof definePlugin>): AgentDefinition {
  return {
    name: "event-agent",
    model: {
      provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" },
      modelId: "m1",
    },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You answer." },
  };
}

describe("event hooks: onInput", () => {
  it("fires once after admission with the input and a full context", async () => {
    const seen: Seen[] = [];
    const plugin = definePlugin("watch", () => ({
      hooks: {
        async onInput(input, ctx) {
          seen.push({ input, ctx });
        },
      },
    }));
    const test = await startTestAgent(definition(plugin));
    test.model.respond([text("answer")]);
    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await client.createConversation();

    await client.submit(id, "hi", { from: { kind: "human" } });
    const first = await eventually(() => seen[0]);
    expect(first.input).toMatchObject({
      conversationId: id,
      content: "hi",
      from: { kind: "human" },
    });
    expect(first.input.submissionId).toBeTruthy();

    expect(first.ctx.conversationId).toBe(id);
    expect(typeof first.ctx.store.agent.get).toBe("function");
    expect(typeof first.ctx.store.case.get).toBe("function");
    expect(typeof first.ctx.files?.list).toBe("function");
    expect(typeof first.ctx.case?.get).toBe("function");
    expect(typeof first.ctx.models.complete).toBe("function");

    // A repeat of the same request id admits nothing and fires nothing.
    await client.submit(id, "hi", { from: { kind: "human" }, requestId: "r1" });
    await client.submit(id, "hi", { from: { kind: "human" }, requestId: "r1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(2);

    await test.dispose();
  });

  it("does not delay the caller when the hook is slow", async () => {
    const plugin = definePlugin("slow", () => ({
      hooks: {
        async onInput() {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        },
      },
    }));
    const test = await startTestAgent(definition(plugin));
    test.model.respond([text("answer")]);
    const { port } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await client.createConversation();

    const begun = Date.now();
    await client.submit(id, "hi");
    expect(Date.now() - begun).toBeLessThan(1000);

    await test.dispose();
  });
});

describe("event hooks: onDecision", () => {
  it("delivers the proposal and the attributed decision, isolating failures", async () => {
    const received: { proposal: Proposal; decision: GateDecision }[] = [];
    let ran = false;
    const failing = definePlugin("a", () => ({
      hooks: {
        async onDecision() {
          throw new Error("nope");
        },
      },
    }));
    const recording = definePlugin("b", () => ({
      hooks: {
        async onDecision(input) {
          received.push(input);
        },
      },
    }));
    const ops = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: {
            title: "Deploy?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          run: async () => {
            ran = true;
            return "deployed";
          },
        }),
      ],
    }));
    const test = await startTestAgent({
      name: "decision-agent",
      model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [
        { plugin: failing, config: {} },
        { plugin: recording, config: {} },
        { plugin: ops, config: {} },
      ],
      channels: [],
      mission: { role: "You deploy when asked." },
    });
    test.model.respond([toolCall("deploy"), text("asked"), text("done")]);
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "ship it");
    const proposal = await waitForProposal(test.agent.host, id);
    const decidedBy = { kind: "human" as const, name: "Ana" };

    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "a",
      instruction: null,
      decidedBy,
    });
    const delivered = await eventually(() => received[0]);
    spy.mockRestore();

    expect(delivered.proposal.title).toBe("Deploy?");
    expect(delivered.proposal.options).toEqual([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    expect(delivered.proposal).not.toHaveProperty("status");
    expect(delivered.decision.decidedBy).toEqual(decidedBy);

    const logged = errors.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain('plugin "a"');
    expect(logged).toContain("onDecision");
    await eventually(() => ran);
    await test.dispose();
  });
});

describe("event hooks around stopping", () => {
  it("drops events raised during stop and logs no error for them", async () => {
    let targetId = "";
    const seen: string[] = [];
    let host: AgentHost | undefined;
    const closer = definePlugin("closer", () => ({
      setup(ctx) {
        host = ctx.host;
      },
      async stop() {
        await host!.updateCase(targetId, { status: "closed" });
      },
    }));
    const watcher = definePlugin("watcher", () => ({
      hooks: {
        async onCaseClosed({ case: closed }) {
          seen.push(`closed:${closed.status}`);
        },
      },
    }));
    const test = await startTestAgent({
      name: "stopping-agent",
      model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [
        { plugin: closer, config: {} },
        { plugin: watcher, config: {} },
      ],
      channels: [],
      mission: { role: "You work cases." },
    });
    const { id } = await test.agent.host.createConversation();
    targetId = id;

    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    await test.agent.stop();
    spy.mockRestore();

    expect(seen).toEqual([]);
    const logged = errors.map((args) => args.join(" ")).join("\n");
    expect(logged).not.toContain("onCaseClosed");
  }, 20_000);

  it("drains a running hook before plugins stop", async () => {
    const log: string[] = [];
    const slow = definePlugin("slow", () => ({
      hooks: {
        async onInput() {
          await new Promise((resolve) => setTimeout(resolve, 300));
          log.push("input-done");
        },
      },
    }));
    const stopper = definePlugin("stopper", () => ({
      stop() {
        log.push("stopped");
      },
    }));
    const test = await startTestAgent({
      name: "draining-agent",
      model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [
        { plugin: slow, config: {} },
        { plugin: stopper, config: {} },
      ],
      channels: [],
      mission: { role: "You answer." },
    });
    test.model.respond([text("answer")]);
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "hi");
    await test.agent.stop();

    expect(log).toEqual(["input-done", "stopped"]);
  }, 20_000);
});

describe("event hooks: onProposalOpened", () => {
  it("fires on open before the decision, with the full proposal, isolating failures", async () => {
    const log: string[] = [];
    const received: Proposal[] = [];
    const failing = definePlugin("a", () => ({
      hooks: {
        async onProposalOpened() {
          throw new Error("nope");
        },
      },
    }));
    const recording = definePlugin("b", () => ({
      hooks: {
        async onProposalOpened({ proposal }, ctx) {
          received.push(proposal);
          log.push(`opened:${proposal.id}:${ctx.conversationId}`);
        },
        async onDecision({ proposal }) {
          log.push(`decided:${proposal.id}`);
        },
      },
    }));
    const ops = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: {
            title: "Deploy?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          run: async () => "deployed",
        }),
      ],
    }));
    const test = await startTestAgent({
      name: "opened-agent",
      model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
      plugins: [
        { plugin: failing, config: {} },
        { plugin: recording, config: {} },
        { plugin: ops, config: {} },
      ],
      channels: [],
      mission: { role: "You deploy when asked." },
    });
    test.model.respond([toolCall("deploy"), text("asked"), text("done")]);
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const { id } = await test.agent.host.createConversation();
    await test.agent.host.submitInput(id, "ship it");
    const proposal = await waitForProposal(test.agent.host, id);
    const delivered = await eventually(() => received[0]);

    expect(delivered).toMatchObject({
      id: proposal.id,
      title: "Deploy?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    expect(delivered.conversationId).toBe(id);
    const open = await test.agent.host.listProposals({ conversationId: id });
    expect(open.map((p) => p.id)).toContain(proposal.id);

    await test.agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "a",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await eventually(() => log.length >= 2);
    expect(log).toEqual([`opened:${proposal.id}:${id}`, `decided:${proposal.id}`]);
    spy.mockRestore();

    const logged = errors.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain('plugin "a"');
    expect(logged).toContain("onProposalOpened");
    await test.dispose();
  });
});
