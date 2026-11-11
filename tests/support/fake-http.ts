// A local HTTP target for tests: records every request and answers from a queue
// (or a default JSON reply).
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export interface RecordedHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeHttpReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface FakeHttp {
  readonly url: string;
  readonly requests: RecordedHttpRequest[];
  /** Queue replies; once empty, every request answers 200 with `{ ok: true }`. */
  respond(...replies: FakeHttpReply[]): void;
  close(): Promise<void>;
}

const open: FakeHttp[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

/** A server that accepts requests and never answers; closed by the same afterEach. */
export async function startHangingHttp(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req) => {
    req.on("data", () => {});
    req.on("end", () => {});
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake = {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  open.push({ ...fake, requests: [], respond: () => {}, close: fake.close });
  return fake;
}

export async function startFakeHttp(host = "127.0.0.1"): Promise<FakeHttp> {
  const requests: RecordedHttpRequest[] = [];
  const queue: FakeHttpReply[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "GET",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      const reply = queue.shift() ?? { body: JSON.stringify({ ok: true }) };
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  const authority = host.includes(":") ? `[${host}]` : host;
  const fake: FakeHttp = {
    url: `http://${authority}:${port}`,
    requests,
    respond: (...replies) => queue.push(...replies),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  open.push(fake);
  return fake;
}
