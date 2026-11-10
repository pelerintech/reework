// onAnswer names the input that started the run: its text, its submission id and
// the author the input was submitted with.
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { Author } from "@reework/types";
import { startTestAgent, text } from "@reework/core/testing";
import { eventually } from "../support/wait.ts";
import { testDefinition } from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

describe("onAnswer", () => {
  it("receives the text, submissionId and from of the input that started the run", async () => {
    const from: Author = { kind: "human", id: "slack:U1", name: "Ana" };
    let seen: { text: string; submissionId: string; from?: Author } | undefined;
    const plugin = definePlugin("answer-watcher", () => ({
      hooks: {
        async onAnswer(input) {
          seen = input;
        },
      },
    }));
    const test = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    running.push(test);
    test.model.respond([text("hello back")]);
    const { id } = await test.agent.host.createConversation();

    const submitted = await test.agent.host.submitInput(id, "hello", {
      from,
      wait: true,
    });
    const input = (await eventually(() => seen))!;

    expect(input.text).toBe("hello back");
    expect(input.submissionId).toBe(submitted.submissionId);
    expect(input.from).toEqual(from);
  });
});
