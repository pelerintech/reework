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

describe("component durable state shares the engine store", () => {
  it("writes a doc family through the seam and recovers it from a fresh session", async () => {
    const path = tmpPath();

    const engine = await Engine.open({ storagePath: path });
    const root = await engine.root();
    const seam = engine.storage;

    const Family = seam.defineDocFamily<{ items: string[] }, string>({
      kind: "app.tasks",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      family: true,
      initial: () => ({ items: [] }),
    });

    await seam.writeFamily(Family, root.id, "summarize", "summarize", (value) => {
      value.items.push("first");
    });
    await engine.close();

    // Fresh engine session over the same sqlite: state is in the same store.
    const engine2 = await Engine.open({ storagePath: path });
    open.push(engine2);
    const root2 = await engine2.root();

    const read = await engine2.storage.readFamily(Family, root2.id, "summarize");
    expect(read?.items).toEqual(["first"]);
  });
});
