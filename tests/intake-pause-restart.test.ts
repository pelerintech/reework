// A pause and its held input survive a restart; a leftover of an interrupted
// resume drains at boot, and a paused agent keeps its held input held.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { IntakeDoc, engineOf } from "@reework/core/internal";
import { scriptedModel, waitForIdle } from "@reework/core/testing";
import { startTestAgent, testDefinition, tmpStorage, untrack } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("a restart over the intake hold", () => {
  it("keeps the pause and its held input, and resume runs it", async () => {
    const storagePath = tmpStorage();
    const first = await startTestAgent(testDefinition(), { storagePath });
    const { id } = await first.host.createConversation();
    const paused = await first.pause();
    await first.host.submitInput(id, "held one");
    await first.stop();
    untrack(first);

    const model = scriptedModel("m1");
    model.respond([fauxAssistantMessage("held answer")]);
    const second = await startTestAgent(testDefinition(), {
      storagePath,
      models: model.models,
    });
    expect(second.paused).toBe(true);
    expect(await second.status()).toMatchObject({
      paused: true,
      pausedAt: paused.pausedAt,
      heldInputs: 1,
    });
    expect((await second.host.snapshot(id)).running).toBe(false);

    const resumed = await second.resume();
    expect(resumed.heldInputs).toBe(0);
    await waitForIdle(second.host, id);
    const messages = (await second.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["held one"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["held answer"]);

    await second.stop();
    untrack(second);
  });

  it("drains held input left by an interrupted resume at boot, in order", async () => {
    const storagePath = tmpStorage();
    const first = await startTestAgent(testDefinition(), { storagePath });
    const { id } = await first.host.createConversation();
    await first.pause();
    await first.host.submitInput(id, "one");
    await first.host.submitInput(id, "two");
    // The resume committed the state and admitted nothing: a crash before the walk.
    await engineOf(first).commit(async (tx) => {
      const intake = await tx.doc(IntakeDoc);
      intake.paused = false;
      intake.resumedAt = Date.now();
    });
    await first.stop();
    untrack(first);

    const model = scriptedModel("m1");
    model.respond([
      (context: { messages: { role: string; content: unknown }[] }) => {
        const user = [...context.messages].reverse().find((m) => m.role === "user");
        return fauxAssistantMessage(user && textOf(user) === "one" ? "one answer" : "two answer");
      },
      fauxAssistantMessage("two answer"),
    ]);
    const second = await startTestAgent(testDefinition(), {
      storagePath,
      models: model.models,
    });
    await eventually(async () => {
      const messages = (await second.host.snapshot(id)).messages;
      return messages.filter((m) => m.role === "assistant").length >= 2;
    });
    await waitForIdle(second.host, id);
    const messages = (await second.host.snapshot(id)).messages;
    expect(messages.filter((m) => m.role === "user").map(textOf)).toEqual(["one", "two"]);
    expect(
      messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .filter(Boolean),
    ).toEqual(["one answer", "two answer"]);
    expect(await second.status()).toMatchObject({ paused: false, heldInputs: 0 });

    await second.stop();
    untrack(second);
  });
});
