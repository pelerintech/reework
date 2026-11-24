// The durable intake hold: pause state on the agent and host, input accepted
// while paused without starting a run, and a resume that runs it in order.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";

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
