// The durable intake hold: pause state on the agent and host, input accepted
// while paused without starting a run, and a resume that runs it in order.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type, definePlugin, defineTool, gatedAction } from "@reework/core";
import type { RunningAgent } from "@reework/core";
import { engineOf } from "@reework/core/internal";
import { waitForIdle, waitForProposal } from "@reework/core/testing";
import { authedApp, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

/** A tool that blocks until released (or the run is aborted). */
function slowTool() {
  const waiters: (() => void)[] = [];
  let starts = 0;
  const tool = defineTool({
    name: "slow",
    description: "Takes a while.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      starts += 1;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        waiters.push(resolve);
      });
      return "slow done";
    },
  });
  return {
    tool,
    release: () => {
      for (const waiter of waiters.splice(0)) waiter();
    },
    started: () => starts,
  };
}

describe("the pause state", () => {
  it("is per agent, readable and idempotent", async () => {
    const agent = await startTestAgent(testDefinition());

    expect(agent.paused).toBe(false);
    expect(agent.host.paused).toBe(false);
    expect(await agent.status()).toEqual({ paused: false, activeRuns: 0, heldInputs: 0 });

    const paused = await agent.pause();
    expect(paused.paused).toBe(true);
    expect(typeof paused.pausedAt).toBe("number");
    expect(agent.paused).toBe(true);
    expect(agent.host.paused).toBe(true);
    expect(await agent.status()).toMatchObject({
      paused: true,
      pausedAt: paused.pausedAt,
      activeRuns: 0,
      heldInputs: 0,
    });

    const again = await agent.pause();
    expect(again.pausedAt).toBe(paused.pausedAt);

    const resumed = await agent.resume();
    expect(resumed.paused).toBe(false);
    expect(typeof resumed.resumedAt).toBe("number");
    expect(agent.paused).toBe(false);
    expect(agent.host.paused).toBe(false);

    const twice = await agent.resume();
    expect(twice.resumedAt).toBe(resumed.resumedAt);
    expect(twice.paused).toBe(false);
  });
});

describe("intake while paused", () => {
  it("accepts and stores input without starting a run", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = await agent.host.createConversation();
    await agent.pause();

    const first = await agent.host.submitInput(id, "first");
    expect(first.held).toBe(true);
    expect(first.message).toBeUndefined();
    expect(typeof first.submissionId).toBe("string");
    expect((await agent.status()).heldInputs).toBe(1);
    expect((await agent.host.snapshot(id)).running).toBe(false);
    expect((await agent.host.readConversation(id)).entries).toEqual([]);

    const second = await agent.host.submitInput(id, "second");
    expect(second.held).toBe(true);
    expect((await agent.status()).heldInputs).toBe(2);

    const waited = await agent.host.submitInput(id, "waiting", { wait: true });
    expect(waited.held).toBe(true);
    expect(waited.message).toBeUndefined();
    expect((await agent.status()).heldInputs).toBe(3);

    const authored = await agent.host.submitInput(id, "from Ana", {
      from: { kind: "human", name: "Ana" },
    });
    expect(authored.held).toBe(true);
    expect((await agent.status()).heldInputs).toBe(4);
    expect((await agent.status()).activeRuns).toBe(0);
  });

  it("answers 202 for a held input submitted with wait through the API", async () => {
    const agent = await startTestAgent(testDefinition());
    const { id } = await agent.host.createConversation();
    await agent.pause();

    const res = await authedApp(agent).request(`/conversations/${id}/messages?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "waiting" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { held?: boolean; message?: unknown };
    expect(body.held).toBe(true);
    expect(body.message).toBeUndefined();
    expect((await agent.status()).heldInputs).toBe(1);
  });

  it("deduplicates a repeated requestId against the held input", async () => {
    const agent = await startTestAgent(testDefinition());
    const { id } = await agent.host.createConversation();
    await agent.pause();

    const first = await agent.host.submitInput(id, "once", { requestId: "r1" });
    const again = await agent.host.submitInput(id, "twice", { requestId: "r1" });
    expect(again.duplicate).toBe(true);
    expect(again.held).toBe(true);
    expect(again.submissionId).toBe(first.submissionId);
    expect((await agent.status()).heldInputs).toBe(1);
  });

  it("resolves files at acceptance and refuses another conversation's file", async () => {
    const agent = await startTestAgent(testDefinition());
    const a = await agent.host.createConversation();
    const b = await agent.host.createConversation();
    const file = await agent.host.addFile(a.id, { name: "notes.txt", bytes: new Uint8Array([1]) });
    await agent.pause();

    const held = await agent.host.submitInput(a.id, "see notes", { files: [file.id] });
    expect(held.held).toBe(true);
    expect((await agent.status()).heldInputs).toBe(1);

    await expect(agent.host.submitInput(b.id, "not mine", { files: [file.id] })).rejects.toThrow(
      /file not found/,
    );
    expect((await agent.status()).heldInputs).toBe(1);
  });
});

/** The text of a message whose content is a string or text blocks. */
function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * Arm a one-shot hook that runs a resume before the next commit. The case-write
 * notification fires after submitInput's case-reopen commit, so the next commit
 * is the hold decision: the resume lands between the paused-cache read and it.
 */
function resumeBeforeNextCommit(agent: RunningAgent) {
  const engine = engineOf(agent);
  const host = agent.host as unknown as { notifyCaseUpdated(c: unknown): void };
  const realCommit = engine.commit.bind(engine);
  const realNotify = host.notifyCaseUpdated.bind(host);
  let armed = false;
  let resume: (() => Promise<unknown>) | undefined;
  engine.commit = ((change: Parameters<typeof realCommit>[0]) => {
    if (!armed) return realCommit(change);
    armed = false;
    return resume!().then(() => realCommit(change));
  }) as typeof engine.commit;
  host.notifyCaseUpdated = (c) => {
    realNotify(c);
    armed = true;
  };
  return {
    onArm(fn: () => Promise<unknown>) {
      resume = fn;
    },
    restore() {
      engine.commit = realCommit as typeof engine.commit;
      host.notifyCaseUpdated = realNotify;
    },
  };
}

/**
 * Hold the first drain's submission check until both resume commits have landed,
 * so the two drains overlap deterministically (no sleeps).
 */
function overlapConcurrentDrains(agent: RunningAgent) {
  const engine = engineOf(agent);
  const realCommit = engine.commit.bind(engine);
  let calls = 0;
  let secondCommitDone!: () => void;
  const secondCommit = new Promise<void>((resolve) => {
    secondCommitDone = resolve;
  });
  engine.commit = ((change: Parameters<typeof realCommit>[0]) => {
    calls += 1;
    if (calls === 3) return secondCommit.then(() => realCommit(change));
    const result = realCommit(change);
    if (calls === 2) result.then(secondCommitDone, secondCommitDone);
    return result;
  }) as typeof engine.commit;
  return {
    restore() {
      engine.commit = realCommit as typeof engine.commit;
    },
  };
}

describe("resuming held input", () => {
  it("runs it in arrival order, one run each, with its author and files", async () => {
    const faux = fauxModels();
    const answer = (context: { messages: { role: string; content: unknown }[] }) => {
      const user = [...context.messages].reverse().find((m) => m.role === "user");
      const prompt = user ? textOf(user) : "";
      const text = ["first", "second", "third"].find((t) => prompt.startsWith(t)) ?? "unknown";
      return fauxAssistantMessage(`${text} answer`);
    };
    faux.respond([answer, answer, answer]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = await agent.host.createConversation();
    const file = await agent.host.addFile(id, { name: "notes.txt", bytes: new Uint8Array([1]) });
    await agent.pause();
    await agent.host.submitInput(id, "first");
    await agent.host.submitInput(id, "second", { mode: "steer" });
    await agent.host.submitInput(id, "third", {
      from: { kind: "human", name: "Ana" },
      files: [file.id],
    });

    const resumed = await agent.resume();
    expect(resumed.heldInputs).toBe(0);
    await waitForIdle(agent.host, id);

    const messages = (await agent.host.snapshot(id)).messages;
    const users = messages.filter((m) => m.role === "user");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(users.map(textOf)).toEqual([
      "first",
      "second",
      "third\n\nAttached: notes.txt (application/octet-stream, 1 bytes, file " + file.id + ")",
    ]);
    expect(users[2]!.from).toEqual({ kind: "human", name: "Ana" });
    expect(assistants.map(textOf).filter(Boolean)).toEqual([
      "first answer",
      "second answer",
      "third answer",
    ]);
  });

  it("queues a held input behind a run still finishing", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("slow done"),
      fauxAssistantMessage("held answer"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "slow-run");
    await eventually(() => slow.started());
    await agent.pause();
    await agent.host.submitInput(id, "held");
    await agent.resume();
    slow.release();
    await waitForIdle(agent.host, id);

    const messages = (await agent.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["slow-run", "held"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["slow done", "held answer"]);
  });
});

describe("held input order is per conversation", () => {
  it("runs one conversation's held inputs one at a time in arrival order", async () => {
    const prompts: string[] = [];
    const answer = (context: { messages: { role: string; content: unknown }[] }) => {
      const user = [...context.messages].reverse().find((m) => m.role === "user");
      const prompt = user ? textOf(user) : "";
      prompts.push(prompt);
      return fauxAssistantMessage(`${prompt} answer`);
    };
    const faux = fauxModels();
    faux.respond([answer, answer, answer]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = await agent.host.createConversation();
    await agent.pause();
    await agent.host.submitInput(id, "first");
    await agent.host.submitInput(id, "second");
    await agent.host.submitInput(id, "third");

    await agent.resume();
    await waitForIdle(agent.host, id);

    expect(prompts).toEqual(["first", "second", "third"]);
    const messages = (await agent.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["first answer", "second answer", "third answer"]);
  });

  it("queues a held input behind a continuation already running in its conversation", async () => {
    const slow = slowTool();
    const decisions: string[] = [];
    const plugin = definePlugin("ops", () => ({
      tools: [
        slow.tool,
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
          async run(_ctx, decision) {
            decisions.push(decision.selectedOption ?? "none");
            return "deployed";
          },
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("continuation answer"),
      fauxAssistantMessage("held answer"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "deploy it");
    const proposal = await waitForProposal(agent.host, id);
    await agent.pause();
    await agent.host.submitInput(id, "held in A");

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await eventually(() => slow.started() >= 1);
    expect(decisions).toEqual(["go"]);
    expect((await agent.status()).activeRuns).toBe(1);

    const resumed = await agent.resume();
    expect(resumed.heldInputs).toBe(0);
    // The held input is admitted but stays queued behind the continuation.
    expect((await agent.status()).activeRuns).toBe(1);
    const before = (await agent.host.snapshot(id)).messages
      .filter((m) => m.role === "user")
      .map(textOf);
    expect(before).not.toContain("held in A");

    slow.release();
    await waitForIdle(agent.host, id);
    const messages = (await agent.host.snapshot(id)).messages;
    const users = messages.filter((m) => m.role === "user").map(textOf);
    expect(users[0]).toBe("deploy it");
    expect(users.some((text) => text.includes("[gated action deploy]"))).toBe(true);
    expect(users[users.length - 1]).toBe("held in A");
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["waiting", "continuation answer", "held answer"]);
  });

  it("lets another conversation's held input start while A's continuation runs", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({
      tools: [
        slow.tool,
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
          async run() {
            return "deployed";
          },
        }),
      ],
    }));
    const afterSlow = (context: { messages: { role: string; content: unknown }[] }) => {
      const user = [...context.messages].reverse().find((m) => m.role === "user");
      return fauxAssistantMessage(
        user && textOf(user).includes("held in B") ? "B answer" : "A continuation answer",
      );
    };
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      afterSlow,
      afterSlow,
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const a = await agent.host.createConversation();
    const b = await agent.host.createConversation();
    await agent.host.submitInput(a.id, "deploy in A");
    const proposal = await waitForProposal(agent.host, a.id);
    await agent.pause();
    await agent.host.submitInput(b.id, "held in B");

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await eventually(() => slow.started() >= 1);
    expect((await agent.status()).activeRuns).toBe(1);

    await agent.resume();
    await eventually(() => slow.started() >= 2);
    // B started and is blocked in its own run while A's continuation is still running.
    expect((await agent.status()).activeRuns).toBe(2);
    expect((await agent.host.snapshot(a.id)).running).toBe(true);
    expect((await agent.host.snapshot(b.id)).running).toBe(true);

    slow.release();
    await waitForIdle(agent.host, a.id);
    await waitForIdle(agent.host, b.id);
    expect((await agent.status()).activeRuns).toBe(0);

    const aMessages = (await agent.host.snapshot(a.id)).messages;
    expect(aMessages.filter((m) => m.role === "user").map(textOf)).not.toContain("held in B");
    expect(
      aMessages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["waiting", "A continuation answer"]);
    const bMessages = (await agent.host.snapshot(b.id)).messages;
    expect(bMessages.filter((m) => m.role === "user").map(textOf)).toEqual(["held in B"]);
    expect(
      bMessages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["B answer"]);
  });
});

describe("input racing a resume", () => {
  it("runs an input submitted while a resume is in progress instead of stranding it", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("during answer")]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = await agent.host.createConversation();
    await agent.pause();

    const hook = resumeBeforeNextCommit(agent);
    hook.onArm(() => agent.resume());
    try {
      const result = await agent.host.submitInput(id, "during resume", { wait: true });
      expect(result.held).toBeUndefined();
      expect(result.message).toBeDefined();
      expect(textOf(result.message!)).toBe("during answer");
    } finally {
      hook.restore();
    }

    expect(await agent.status()).toMatchObject({ paused: false, heldInputs: 0, activeRuns: 0 });
    const messages = (await agent.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["during resume"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["during answer"]);
  });

  it("runs each held input exactly once when two resumes race", async () => {
    const prompts: string[] = [];
    const answer = (context: { messages: { role: string; content: unknown }[] }) => {
      const user = [...context.messages].reverse().find((m) => m.role === "user");
      const prompt = user ? textOf(user) : "";
      prompts.push(prompt);
      return fauxAssistantMessage(`${prompt} answer`);
    };
    const faux = fauxModels();
    faux.respond([answer, answer]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { id } = await agent.host.createConversation();
    await agent.pause();
    await agent.host.submitInput(id, "one");
    await agent.host.submitInput(id, "two");

    const hook = overlapConcurrentDrains(agent);
    try {
      const [first, second] = await Promise.all([agent.resume(), agent.resume()]);
      expect(first.heldInputs).toBe(0);
      expect(second.heldInputs).toBe(0);
    } finally {
      hook.restore();
    }

    await waitForIdle(agent.host, id);
    expect(prompts.filter((prompt) => prompt === "one")).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt === "two")).toHaveLength(1);
    expect(await agent.status()).toMatchObject({ paused: false, heldInputs: 0, activeRuns: 0 });
    const messages = (await agent.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["one", "two"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["one answer", "two answer"]);
  });
});
