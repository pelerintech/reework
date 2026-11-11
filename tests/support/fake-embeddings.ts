// A local OpenAI-compatible embeddings endpoint for tests: records every
// request's `{ model, input }` and answers from a queue of vector replies.
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export interface RecordedEmbeddingRequest {
  readonly model: string;
  readonly input: readonly string[];
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
}

export interface EmbeddingItem {
  readonly index?: number;
  readonly embedding?: number[];
}

export interface EmbeddingReply {
  readonly embeddings?: number[][];
  readonly items?: EmbeddingItem[];
  readonly usage?: { readonly promptTokens?: number; readonly totalTokens?: number };
}

export interface FakeEmbeddings {
  /** Base URL for OpenAI-style endpoints (ends in `/v1`). */
  readonly url: string;
  readonly requests: RecordedEmbeddingRequest[];
  /** Queue replies; once empty, every request answers one empty vector. */
  respond(...replies: EmbeddingReply[]): void;
  close(): Promise<void>;
}

const open: FakeEmbeddings[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

export async function startFakeEmbeddings(): Promise<FakeEmbeddings> {
  const requests: RecordedEmbeddingRequest[] = [];
  const queue: EmbeddingReply[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; input: string[] };
      requests.push({
        model: parsed.model,
        input: parsed.input,
        headers: req.headers,
        path: req.url ?? "",
      });
      const reply = queue.shift() ?? { embeddings: [] };
      const items =
        reply.items ?? (reply.embeddings ?? []).map((embedding, index) => ({ embedding, index }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model: parsed.model,
          data: items.map((item) => ({
            object: "embedding",
            ...(item.embedding === undefined ? {} : { embedding: item.embedding }),
            ...(item.index === undefined ? {} : { index: item.index }),
          })),
          ...(reply.usage
            ? {
                usage: {
                  prompt_tokens: reply.usage.promptTokens ?? 0,
                  total_tokens: reply.usage.totalTokens ?? reply.usage.promptTokens ?? 0,
                },
              }
            : {}),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeEmbeddings = {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    respond: (...replies) => queue.push(...replies),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  open.push(fake);
  return fake;
}
