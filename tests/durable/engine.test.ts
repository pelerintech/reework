import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineDoc } from "@earendil-works/pi-durable";

import { CONTEXT, Engine } from "@reework/core/internal";

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

describe("durable engine over sqlite storage", () => {
  it("opens a session over a tmp sqlite path and reads/writes a doc", async () => {
    const engine = await Engine.open({ storagePath: tmpPath() });
    open.push(engine);

    const Todos = defineDoc<{ items: string[] }>({
      kind: "app.todos",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ items: [] }),
    });

    const root = await engine.root();
    await engine.commit(async (tx) => {
      (await tx.doc(Todos, root.id)).items.push("write docs");
    });

    const read = await engine.harness.snapshot(Todos, root.id, CONTEXT);
    expect(read?.items).toEqual(["write docs"]);
  });
});
