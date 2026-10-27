import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ENGINE_TEST_MODELS } from "./model-setup.js";

import { Engine } from "@reework/core/internal";

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

describe("conversation driven to completion", () => {
  it("submits a run against the mock provider and reaches a terminal completed state", async () => {
    const models = ENGINE_TEST_MODELS();
    models.setResponses([fauxAssistantMessage("The capital of France is Paris.")]);
    const engine = await Engine.open({ storagePath: tmpPath(), models: models.models });
    open.push(engine);

    const answer = await engine.run("What is the capital of France?");
    expect(answer).toContain("Paris");
  });
});
