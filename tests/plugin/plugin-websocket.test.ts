// Plugin WebSockets: a plugin route upgrades a request through the agent's own
// listener, behind the same token as its HTTP routes.
import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { definePlugin } from "@reework/core";
import type { RouteContext } from "@reework/core";
import {
  authHeaders,
  authedApp,
  startTestAgent,
  testDefinition,
  untrack,
} from "../support/agent.ts";
import { eventually } from "../support/wait.ts";

/** Connect a real `ws` client; resolves once the handshake completes. */
function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Try a handshake that must fail; closes the socket if it unexpectedly opens. */
async function refusal(url: string, headers: Record<string, string> = {}): Promise<Error> {
  try {
    const socket = await open(url, headers);
    socket.close();
    throw new Error("the handshake was accepted");
  } catch (error) {
    return error as Error;
  }
}

/** One plain HTTP GET against the listener. */
function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The next frame as text (text and binary frames alike). */
function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve((data as Buffer).toString("utf8")));
  });
}

describe("plugin websockets: upgrade behind the token", () => {
  it("opens on a plugin route, echoes text and binary, and closes with the plugin's handler", async () => {
    let opened = 0;
    let closed: { code: number; reason: string } | undefined;
    const factory = vi.fn(() => ({
      onOpen() {
        opened += 1;
      },
      onMessage(data: string | Uint8Array, socket: { send(data: string | Uint8Array): void }) {
        socket.send(`echo:${typeof data === "string" ? data : data.byteLength}`);
      },
      onClose(code: number, reason: string) {
        closed = { code, reason };
      },
    }));
    const plugin = definePlugin("echo", () => ({
      routes(app, ctx) {
        app.get("/echo", ctx.upgradeWebSocket(factory));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/echo/echo`;

    const socket = await open(url, authHeaders);
    await eventually(() => opened === 1);

    const text = nextMessage(socket);
    socket.send("hi");
    expect(await text).toBe("echo:hi");

    const binary = nextMessage(socket);
    socket.send(Buffer.from("abcd"));
    expect(await binary).toBe("echo:4");

    socket.close(1000, "bye");
    await eventually(() => closed?.code === 1000);
    expect(closed?.reason).toBe("bye");
  });

  it("refuses without the token before the factory runs", async () => {
    let opened = 0;
    const factory = vi.fn(() => ({
      onOpen() {
        opened += 1;
      },
    }));
    const plugin = definePlugin("echo", () => ({
      routes(app, ctx) {
        app.get("/echo", ctx.upgradeWebSocket(factory));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/echo/echo`;

    await expect(open(url)).rejects.toThrow(/401/);
    await expect(open(url, { authorization: "Bearer wrong" })).rejects.toThrow(/401/);
    expect(factory).not.toHaveBeenCalled();
    expect(opened).toBe(0);
  });

  it("answers a plain request without an upgrade with 426", async () => {
    const factory = vi.fn(() => ({}));
    const plugin = definePlugin("echo", () => ({
      routes(app, ctx) {
        app.get("/echo", ctx.upgradeWebSocket(factory));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));

    const response = await authedApp(agent).request("/plugins/echo/echo");
    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: "websocket_upgrade_required" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("answers 426 when the request lacks Connection: Upgrade", async () => {
    const factory = vi.fn(() => ({}));
    const plugin = definePlugin("echo", () => ({
      routes(app, ctx) {
        app.get("/echo", ctx.upgradeWebSocket(factory));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);

    const response = await httpGet(port, "/plugins/echo/echo", {
      authorization: authHeaders.authorization,
      upgrade: "websocket",
    });
    expect(response.status).toBe(426);
    expect(JSON.parse(response.body)).toEqual({ error: "websocket_upgrade_required" });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("plugin websockets: the /open/ gate", () => {
  it("lets the plugin's async factory refuse the handshake with a response", async () => {
    const factory = vi.fn(async (c: RouteContext) => {
      if (c.req.query("secret") !== "s3") return c.json({ error: "unauthorized" }, 401);
      return {
        onMessage(data: string | Uint8Array, socket: { send(data: string | Uint8Array): void }) {
          socket.send(`echo:${typeof data === "string" ? data : data.byteLength}`);
        },
      };
    });
    const plugin = definePlugin("hookin", () => ({
      routes(app, ctx) {
        app.get("/open/inbound", ctx.upgradeWebSocket(factory));
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/hookin/open/inbound`;

    expect((await refusal(url)).message).toMatch(/401/);
    expect(factory).toHaveBeenCalledTimes(1);

    const socket = await open(`${url}?secret=s3`);
    const echo = nextMessage(socket);
    socket.send("hi");
    expect(await echo).toBe("echo:hi");
    socket.close();
  });
});

/** The next close frame. */
function closedWith(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("plugin websockets: limits", () => {
  it("closes an oversized message with 1009 and does not call the handler", async () => {
    let messages = 0;
    const plugin = definePlugin("limited", () => ({
      routes(app, ctx) {
        app.get(
          "/big",
          ctx.upgradeWebSocket(() => ({
            onMessage(_data, socket) {
              messages += 1;
              socket.send("seen");
            },
          })),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const socket = await open(`ws://127.0.0.1:${port}/plugins/limited/big`, authHeaders);

    const closed = closedWith(socket);
    socket.send("x".repeat(1_048_577));
    expect(await closed).toEqual({ code: 1009, reason: "message too big" });
    expect(messages).toBe(0);
  });

  it("refuses a frame past ws's own ceiling with the required reason", async () => {
    const plugin = definePlugin("limited", () => ({
      routes(app, ctx) {
        app.get(
          "/big",
          ctx.upgradeWebSocket(() => ({})),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const socket = await open(`ws://127.0.0.1:${port}/plugins/limited/big`, authHeaders);

    const closed = closedWith(socket);
    socket.send(Buffer.alloc(101 * 1024 * 1024));
    expect(await closed).toEqual({ code: 1009, reason: "message too big" });
  });

  it("lets a route set a smaller message limit", async () => {
    const plugin = definePlugin("limited", () => ({
      routes(app, ctx) {
        app.get(
          "/small",
          ctx.upgradeWebSocket(
            () => ({
              onMessage(data, socket) {
                socket.send(`got:${typeof data === "string" ? data : data.byteLength}`);
              },
            }),
            { maxMessageBytes: 4 },
          ),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const socket = await open(`ws://127.0.0.1:${port}/plugins/limited/small`, authHeaders);

    const echo = nextMessage(socket);
    socket.send("abcd");
    expect(await echo).toBe("got:abcd");

    const closed = closedWith(socket);
    socket.send("abcde");
    expect(await closed).toEqual({ code: 1009, reason: "message too big" });
  });

  it("caps concurrent sockets per plugin and frees a slot", async () => {
    const plugin = definePlugin("limited", () => ({
      routes(app, ctx) {
        app.get(
          "/one",
          ctx.upgradeWebSocket(() => ({}), { maxSockets: 1 }),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/limited/one`;

    const first = await open(url, authHeaders);
    expect((await refusal(url, authHeaders)).message).toMatch(/429/);

    const firstClosed = closedWith(first);
    first.close();
    await firstClosed;

    const third = await eventually(async () => {
      try {
        return await open(url, authHeaders);
      } catch {
        return undefined;
      }
    });
    third?.close();
  });

  it("counts handshakes still in flight against the cap", async () => {
    const plugin = definePlugin("limited", () => ({
      routes(app, ctx) {
        app.get(
          "/slow",
          ctx.upgradeWebSocket(
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 150));
              return {};
            },
            { maxSockets: 1 },
          ),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/limited/slow`;

    const results = await Promise.allSettled([open(url, authHeaders), open(url, authHeaders)]);
    const opened = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason.message).toMatch(/429/);
    for (const result of opened) (result as PromiseFulfilledResult<WebSocket>).value.close();
  });

  it("rejects limits that are not positive integers at the upgrade call", async () => {
    const cases = [
      { maxSockets: 1.5 },
      { maxSockets: 0 },
      { maxSockets: -3 },
      { maxMessageBytes: 0 },
      { maxMessageBytes: 1.5 },
    ];
    for (const limits of cases) {
      const plugin = definePlugin("bad", () => ({
        routes(app, ctx) {
          app.get(
            "/bad",
            ctx.upgradeWebSocket(() => ({}), limits),
          );
        },
      }));
      await expect(
        startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] })),
      ).rejects.toThrow(/positive integer/);
    }
  });

  it("clamps a per-call cap to the plugin ceiling", async () => {
    const plugin = definePlugin("limited", () => ({
      routes(app, ctx) {
        app.get(
          "/spread",
          ctx.upgradeWebSocket(() => ({}), { maxSockets: 70 }),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/limited/spread`;

    const sockets = await Promise.all(Array.from({ length: 64 }, () => open(url, authHeaders)));
    expect((await refusal(url, authHeaders)).message).toMatch(/429/);
    for (const socket of sockets) socket.close();
  });
});

describe("plugin websockets: stop", () => {
  it("closes open sockets with a reason before stopping", async () => {
    let closedByPlugin: { code: number; reason: string } | undefined;
    const plugin = definePlugin("echo", () => ({
      routes(app, ctx) {
        app.get(
          "/echo",
          ctx.upgradeWebSocket(() => ({
            onClose(code: number, reason: string) {
              closedByPlugin = { code, reason };
            },
          })),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const socket = await open(`ws://127.0.0.1:${port}/plugins/echo/echo`, authHeaders);

    const clientClose = closedWith(socket);
    const stopping = agent.stop();
    expect(await clientClose).toEqual({ code: 1001, reason: "agent stopping" });
    await stopping;
    untrack(agent);
    expect(closedByPlugin).toEqual({ code: 1001, reason: "agent stopping" });
  });
});

describe("plugin websockets: handler errors", () => {
  it("logs a failing handler and keeps the server serving", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args.map(String).join(" ")));
    const plugin = definePlugin("boom", () => ({
      routes(app, ctx) {
        app.get(
          "/boom",
          ctx.upgradeWebSocket(() => ({
            onMessage(
              data: string | Uint8Array,
              socket: { send(data: string | Uint8Array): void },
            ) {
              if (data === "throw") throw new Error("sync boom");
              if (data === "reject") return Promise.reject(new Error("async boom"));
              socket.send(`ok:${typeof data === "string" ? data : data.byteLength}`);
            },
          })),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const socket = await open(`ws://127.0.0.1:${port}/plugins/boom/boom`, authHeaders);

    socket.send("throw");
    await eventually(() => errors.some((entry) => entry.includes("sync boom")));
    expect(
      errors.some((entry) => entry.includes('plugin "boom"') && entry.includes("socket failed")),
    ).toBe(true);

    const after = nextMessage(socket);
    socket.send("after");
    expect(await after).toBe("ok:after");

    socket.send("reject");
    await eventually(() => errors.some((entry) => entry.includes("async boom")));
    expect(errors.filter((entry) => entry.includes("socket failed"))).toHaveLength(2);

    const health = await authedApp(agent).request("/health");
    expect(health.status).toBe(200);
    spy.mockRestore();
  });

  it("logs a thenable handler's rejection", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args.map(String).join(" ")));
    const plugin = definePlugin("thenable", () => ({
      routes(app, ctx) {
        app.get(
          "/thenable",
          ctx.upgradeWebSocket(() => ({
            onMessage(
              data: string | Uint8Array,
              socket: { send(data: string | Uint8Array): void },
            ) {
              if (data === "thenable") {
                /* oxlint-disable unicorn/no-thenable */
                return {
                  then(_resolve: (value: void) => void, reject: (error: Error) => void) {
                    setTimeout(() => reject(new Error("thenable boom")), 0);
                  },
                } as unknown as Promise<void>;
                /* oxlint-enable unicorn/no-thenable */
              }
              socket.send("ok");
            },
          })),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const socket = await open(`ws://127.0.0.1:${port}/plugins/thenable/thenable`, authHeaders);

    socket.send("thenable");
    await eventually(() => errors.some((entry) => entry.includes("thenable boom")));
    expect(
      errors.some(
        (entry) => entry.includes('plugin "thenable"') && entry.includes("socket failed"),
      ),
    ).toBe(true);

    const after = nextMessage(socket);
    socket.send("after");
    expect(await after).toBe("ok");
    spy.mockRestore();
  });
});
