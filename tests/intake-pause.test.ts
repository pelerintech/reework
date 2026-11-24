// The durable intake hold: pause state on the agent and host, input accepted
// while paused without starting a run, and a resume that runs it in order.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type, definePlugin, defineTool } from "@reework/core";
import { waitForIdle } from "@reework/core/testing";
import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
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
