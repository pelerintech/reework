// Plugin WebSockets: a plugin route upgrades a request through the agent's own
// listener, behind the same token as its HTTP routes.
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { definePlugin } from "@reework/core";
import type { RouteContext } from "@reework/core";
import { authHeaders, authedApp, startTestAgent, testDefinition } from "../support/agent.ts";
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
