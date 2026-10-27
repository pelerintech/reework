import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { CONTEXT, Engine } from "@reework/core/internal";

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("crash + resume recovers the checkpoint", () => {
  it("resumes a run interrupted by a simulated crash and completes it", async () => {
    const path = tmpPath();

    // Engine A: the model hangs, so the run is left in flight when we "crash".
    const mockA = ENGINE_TEST_MODELS();
    mockA.setResponses([() => new Promise(() => {})]);
    const engineA = await Engine.open({ storagePath: path, models: mockA.models });
    const rootA = await engineA.root();
    const submission = await rootA.submit({ type: "input", content: "do work" }, CONTEXT);
    const submissionId = submission.id;
    await sleep(200);
    // Simulate a crash: engineA is abandoned without close() or resume().

    // Engine B: a fresh session over the same storage; resume() continues the run.
    const mockB = ENGINE_TEST_MODELS();
    mockB.setResponses([fauxAssistantMessage("recovered from checkpoint")]);
    const engineB = await Engine.open({ storagePath: path, models: mockB.models });
    open.push(engineB);
    engineB.resume();

    const subB = await engineB.harness.submission(submissionId, CONTEXT);
    expect(subB).toBeDefined();
    const settled = await subB!.wait(CONTEXT);
    expect(settled.status).toBe("done");
  });
});
