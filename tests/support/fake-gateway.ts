// A local secrets gateway for tests: proxy, raw and model pass-through routes
// with the wire protocol core's gateway backend speaks.
import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export interface RecordedGatewayRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

export interface GatewaySecret {
  readonly value: string;
  readonly header?: string;
  readonly query?: string;
  readonly hosts?: readonly string[];
}

export interface GatewayUpstream {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface FakeGatewayConfig {
  readonly secrets: Record<string, GatewaySecret>;
  readonly raw: readonly string[];
  readonly upstreams: Record<string, GatewayUpstream>;
}

export interface FakeGateway {
  readonly url: string;
  readonly requests: RecordedGatewayRequest[];
  close(): Promise<void>;
}

const open: FakeGateway[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

const PROXY = "/plugins/secrets-gateway/open/proxy";
const RAW = "/plugins/secrets-gateway/open/raw";
const LLM = "/plugins/secrets-gateway/open/llm/";

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeGateway(config: FakeGatewayConfig): Promise<FakeGateway> {
  const requests: RecordedGatewayRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const path = req.url ?? "";
      if (path === PROXY) {
        const secret = config.secrets[String(body.secret)];
        const target = String(body.url);
        if (!secret) return reply(res, 403, { error: "secret not allowed" });
        const url = new URL(target);
        if (secret.hosts && !secret.hosts.includes(url.hostname)) {
          return reply(res, 403, { error: "host not allowed" });
        }
        const headers = new Headers((body.headers ?? {}) as Record<string, string>);
        if (secret.header) headers.set(secret.header, secret.value);
        if (secret.query) url.searchParams.set(secret.query, secret.value);
        const upstream = await fetch(url, {
          method: typeof body.method === "string" ? body.method : "GET",
          headers,
          ...(typeof body.body === "string" ? { body: body.body } : {}),
        });
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "",
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      if (path === RAW) {
        const name = String(body.secret);
        const secret = config.secrets[name];
        if (!secret || !config.raw.includes(name)) {
          return reply(res, 403, { error: "raw not allowed" });
        }
        return reply(res, 200, { value: secret.value });
      }
      if (path.startsWith(LLM)) {
        const rest = path.slice(LLM.length);
        const slash = rest.indexOf("/");
        const upstreamName = slash < 0 ? rest : rest.slice(0, slash);
        const suffix = slash < 0 ? "" : rest.slice(slash);
        const upstream = config.upstreams[upstreamName];
        if (!upstream) return reply(res, 403, { error: "upstream not allowed" });
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value !== "string") continue;
          if (key === "authorization" || key === "host" || key === "content-length") continue;
          headers.set(key, value);
        }
        headers.set("authorization", `Bearer ${upstream.apiKey}`);
        const forwarded = await fetch(`${upstream.baseUrl}${suffix}`, {
          method: req.method ?? "POST",
          headers,
          ...(raw ? { body: raw } : {}),
        });
        res.writeHead(forwarded.status, {
          "content-type": forwarded.headers.get("content-type") ?? "text/event-stream",
        });
        res.end(Buffer.from(await forwarded.arrayBuffer()));
        return;
      }
      reply(res, 404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeGateway = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  open.push(fake);
  return fake;
}
