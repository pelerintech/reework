// Files over the protocol: upload, list, download, names, types, the size limit, restart.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startAgent } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import {
  fauxModels,
  startTestAgent,
  testDefinition,
  authedApp,
  tmpStorage,
} from "../support/agent.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const PDF = new TextEncoder().encode("%PDF-1.4 hello");

describe("files over the protocol", () => {
  it("uploads, lists and downloads a file, with the right record and headers", async () => {
    const agent = await startTestAgent(testDefinition());
    const app = authedApp(agent);
    const { id } = await agent.host.createConversation();

    const up = await app.request(`/conversations/${id}/files?name=a.pdf`, {
      method: "POST",
      body: PDF,
      headers: { "content-type": "application/pdf" },
    });
    expect(up.status).toBe(201);
    const record = (await up.json()) as {
      id: string;
      name: string;
      mimeType: string;
      size: number;
      sha256: string;
      source: string;
    };
    expect(record.name).toBe("a.pdf");
    expect(record.mimeType).toBe("application/pdf");
    expect(record.size).toBe(PDF.length);
    expect(record.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(record.id).toBeTruthy();

    const list = await app.request(`/conversations/${id}/files`);
    const listed = (await list.json()) as { files: { id: string; source: string }[] };
    expect(listed.files).toEqual([expect.objectContaining({ id: record.id, source: "upload" })]);

    const dl = await app.request(`/conversations/${id}/files/${record.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="a.pdf"');
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF);
  });

  it("sanitizes the name and defaults a missing type", async () => {
    const agent = await startTestAgent(testDefinition());
    const app = authedApp(agent);
    const { id } = await agent.host.createConversation();
    const up = await app.request(
      `/conversations/${id}/files?name=${encodeURIComponent("../x/a.pdf")}`,
      {
        method: "POST",
        body: PDF,
      },
    );
    expect(up.status).toBe(201);
    const record = (await up.json()) as { name: string; mimeType: string };
    expect(record.name).toBe("a.pdf");
    expect(record.mimeType).toBe("application/octet-stream");
  });

  it("refuses an upload without a name, and an unknown conversation", async () => {
    const agent = await startTestAgent(testDefinition());
    const app = authedApp(agent);
    const { id } = await agent.host.createConversation();
    expect(
      (await app.request(`/conversations/${id}/files`, { method: "POST", body: PDF })).status,
    ).toBe(400);
    expect(
      (await app.request(`/conversations/999999/files?name=a.pdf`, { method: "POST", body: PDF }))
        .status,
    ).toBe(404);
  });

  it("enforces files.maxBytes at the route and at host.addFile", async () => {
    const agent = await startTestAgent(testDefinition({ files: { maxBytes: 1000 } }));
    const app = authedApp(agent);
    const { id } = await agent.host.createConversation();
    const big = new Uint8Array(1001);
    const refused = await app.request(`/conversations/${id}/files?name=big.bin`, {
      method: "POST",
      body: big,
    });
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toBe("file_too_large");
    expect(
      ((await (await app.request(`/conversations/${id}/files`)).json()) as { files: unknown[] })
        .files,
    ).toEqual([]);
    await expect(agent.host.addFile(id, { name: "big.bin", bytes: big })).rejects.toThrow(
      /too large/,
    );
  });

  it("keeps files across a restart on the same storage", async () => {
    const storagePath = tmpStorage();
    const models = fauxModels().models;
    const def: AgentDefinition = testDefinition();
    const first = await startAgent(def, { storagePath, models, auth: { token: "t" } });
    const { id } = await first.host.createConversation({ key: "persist" });
    const record = await first.host.addFile(id, {
      name: "a.pdf",
      mimeType: "application/pdf",
      bytes: PDF,
    });
    await first.stop();

    const second = await startAgent(def, { storagePath, models, auth: { token: "t" } });
    running.push({ dispose: () => second.stop() });
    expect((await second.host.listFiles(id)).map((f) => f.id)).toEqual([record.id]);
    expect(new Uint8Array((await second.host.readFile(id, record.id)).bytes)).toEqual(PDF);
  });
});
