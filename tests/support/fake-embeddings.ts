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
  readonly embedding?: readonly unknown[];
}

export interface EmbeddingReply {
  readonly embeddings?: number[][];
  readonly items?: EmbeddingItem[];
  readonly usage?: { readonly promptTokens?: number; readonly totalTokens?: number };
  /** Hold the reply for this long, so a test can abort or time out in flight. */
  readonly delayMs?: number;
  /** Send this body verbatim instead of the JSON shape (a malformed reply). */
  readonly raw?: string;
}

export interface FakeEmbeddings {
  /** Base URL for OpenAI-style endpoints (ends in `/v1`). */
  readonly url: string;
  readonly requests: RecordedEmbeddingRequest[];
  /** Requests being answered right now, and the most seen at once. */
  readonly load: { inFlight: number; peak: number };
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
  const timers = new Set<NodeJS.Timeout>();
  const load = { inFlight: 0, peak: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; input: string[] };
      load.inFlight += 1;
      load.peak = Math.max(load.peak, load.inFlight);
      requests.push({
        model: parsed.model,
        input: parsed.input,
        headers: req.headers,
        path: req.url ?? "",
      });
      const reply = queue.shift() ?? { embeddings: [] };
      const items =
        reply.items ?? (reply.embeddings ?? []).map((embedding, index) => ({ embedding, index }));
      const send = () => {
        load.inFlight -= 1;
        if (reply.raw !== undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(reply.raw);
          return;
        }
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
      };
      if (reply.delayMs === undefined) send();
      else {
        const timer = setTimeout(() => {
          timers.delete(timer);
          send();
        }, reply.delayMs);
        timers.add(timer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeEmbeddings = {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    load,
    respond: (...replies) => queue.push(...replies),
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  open.push(fake);
  return fake;
}
