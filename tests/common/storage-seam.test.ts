import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

describe("common tooling storage seam", () => {
  it("exposes a storage seam backed by pi-durable doc primitives", async () => {
    const engine = await Engine.open({ storagePath: tmpPath() });
    open.push(engine);

    const seam = engine.storage;
    expect(seam.defineDoc).toBeTypeOf("function");
    expect(seam.defineDocFamily).toBeTypeOf("function");

    // A doc family can be defined through the seam.
    const Family = seam.defineDocFamily<{ items: string[] }, string>({
      kind: "app.tasks",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      family: true,
      initial: () => ({ items: [] }),
    });
    expect(Family.definition.kind).toBe("app.tasks");
  });
});
