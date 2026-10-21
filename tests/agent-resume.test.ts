import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

describe("startAgent resumes unfinished work", () => {
  it("answers an input the previous process admitted but never answered", async () => {
    const storagePath = tmpStorage();
    let modelCalled = false;
    const stuck = fauxModels();
    stuck.respond([
      (_context, options) =>
        new Promise((_resolve, reject) => {
          modelCalled = true;
          options?.signal?.addEventListener("abort", () => reject(new Error("stopped")));
        }),
    ]);
    const first = await startTestAgent(testDefinition(), { storagePath, models: stuck.models });
    const { id } = await first.host.createConversation();
    await first.host.submitInput(id, "please answer eventually");
    await eventually(() => modelCalled);
    untrack(first);
    await first.stop();

    const answering = fauxModels();
    answering.respond([fauxAssistantMessage("resumed answer")]);
    const second = await startTestAgent(testDefinition(), {
      storagePath,
      models: answering.models,
    });

    await eventually(async () =>
      JSON.stringify(await second.host.readConversation(id)).includes("resumed answer"),
    );
    const inputs = (await second.host.readConversation(id)).entries.filter(
      (e) => e.kind === "pi.user",
    );
    expect(inputs).toHaveLength(1);
  });
});
