import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { CONTEXT, Engine } from "@reework/core";
import { ENGINE_TEST_MODELS } from "./model-setup.js";

const open: Engine[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}

afterEach(async () => {
  while (open.length > 0) {
    const engine = open.pop()!;
    await engine.close();
  }
});

describe("durable state persists across sessions", () => {
  it("reopens a fresh session over the same storage and reads prior state", async () => {
    const path = tmpPath();

    // First session: run a conversation and write a durable doc.
    const mockA = ENGINE_TEST_MODELS();
    mockA.setResponses([fauxAssistantMessage("the answer is forty-two")]);
    const engineA = await Engine.open({ storagePath: path, models: mockA.models });
    const answer = await engineA.run("what is the answer?");
    expect(answer).toContain("forty-two");

    const Notes = defineDoc<{ note: string }>({
      kind: "app.note",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ note: "" }),
    });
    const rootA = await engineA.root();
    await engineA.commit(async (tx) => {
      (await tx.doc(Notes, rootA.id)).note = "persisted note";
    });
    await engineA.close();

    // Fresh session over the same storage: state is still readable.
    const mockB = ENGINE_TEST_MODELS();
    const engineB = await Engine.open({ storagePath: path, models: mockB.models });
    open.push(engineB);

    const note = await engineB.harness.snapshot(Notes, rootA.id, CONTEXT);
    expect(note?.note).toBe("persisted note");

    // The completed run's conversation is still present, answer entry readable.
    const rootB = await engineB.root();
    const entries = await rootB.entries({ order: "descending" }, 50, undefined, CONTEXT);
    expect(entries.items.length).toBeGreaterThan(0);
  });
});
