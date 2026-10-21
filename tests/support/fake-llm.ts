// A local model endpoint for tests: speaks streaming OpenAI chat completions and
// Anthropic messages, records every request, and replies from a script.
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export type FakeReply = { text: string } | { status: number; body?: string };

export interface RecordedRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

export interface FakeLlm {
  /** Base URL for OpenAI-style endpoints (ends in `/v1`). */
  readonly url: string;
  /** Base URL without `/v1`, for Anthropic-style endpoints (the SDK appends `/v1`). */
  readonly root: string;
  readonly requests: RecordedRequest[];
  /** Queue replies; once empty, every request answers `"ok"`. */
  script(...replies: FakeReply[]): void;
  close(): Promise<void>;
}

const open: FakeLlm[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

function sse(event: string | undefined, data: unknown): string {
  return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function openAiStream(text: string, model: string): string {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model };
  return [
    sse(undefined, {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }),
    sse(undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sse(undefined, {
      ...base,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    sse(undefined, "[DONE]"),
  ].join("");
}

function anthropicStream(text: string, model: string): string {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const requests: RecordedRequest[] = [];
  const queue: FakeReply[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const reply = queue.shift() ?? { text: "ok" };
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body ?? JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }
      const model = typeof body.model === "string" ? body.model : "m1";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(
        (req.url ?? "").split("?")[0].endsWith("/messages")
          ? anthropicStream(reply.text, model)
          : openAiStream(reply.text, model),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeLlm = {
    url: `http://127.0.0.1:${port}/v1`,
    root: `http://127.0.0.1:${port}`,
    requests,
    script: (...replies) => queue.push(...replies),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  open.push(fake);
  return fake;
}

/** All system/instruction text the model was sent in a recorded request. */
export function systemText(request: RecordedRequest): string {
  const body = request.body;
  const parts: string[] = [];
  if (typeof body.system === "string") parts.push(body.system);
  if (Array.isArray(body.system)) {
    for (const block of body.system as { text?: unknown }[]) {
      if (typeof block.text === "string") parts.push(block.text);
    }
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages as { role?: string; content?: unknown }[]) {
      if (message.role === "system" || message.role === "developer") {
        parts.push(
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        );
      }
    }
  }
  return parts.join("\n");
}

/** Names of the tools offered to the model in a recorded request. */
export function offeredTools(request: RecordedRequest): string[] {
  const tools = (request.body.tools ?? []) as { name?: string; function?: { name?: string } }[];
  return tools.map((tool) => tool.function?.name ?? tool.name ?? "");
}
