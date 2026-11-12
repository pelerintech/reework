// Plugin WebSocket shutdown: sockets that never confirm a close are counted
// like other unfinished work, and the stop deadline names them.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { definePlugin } from "@reework/core";
import { engineOf } from "@reework/core/internal";
import {
  TEST_TOKEN,
  authHeaders,
  startTestAgent,
  testDefinition,
  untrack,
} from "../support/agent.ts";
import { eventually } from "../support/wait.ts";

/** Complete a WebSocket handshake with a raw socket that reads nothing afterwards. */
function rawUpgrade(
  port: number,
  path: string,
): Promise<{ response: IncomingMessage; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (response, socket) => resolve({ response, socket }));
    req.on("error", reject);
    req.end();
  });
}

/** Settle a promise within `ms`, so a hung stop fails the test instead of hanging it. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Open a protocol `conversations.watch` socket against the listening agent. */
async function openWatch(port: number, conversationId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/conversations/${conversationId}/ws`, {
    headers: authHeaders,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

describe("plugin websockets: shutdown", () => {
  it("counts a socket that never confirms its close", async () => {
    const plugin = definePlugin("a", () => ({
      routes(app, ctx) {
        app.get(
          "/stuck",
          ctx.upgradeWebSocket(() => ({})),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);

    const { response, socket } = await rawUpgrade(port, "/plugins/a/stuck");
    expect(response.statusCode).toBe(101);
    socket.pause();

    await expect(agent.stop({ timeoutMs: 500 })).rejects.toThrow(
      /still running: plugin socket "a"/,
    );
    untrack(agent);
    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
    socket.resume();
    await eventually(() => socket.destroyed);
    socket.destroy();
  });

  it("settles stop within its deadline with a watch socket open", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    const { id } = await agent.host.createConversation();
    const watch = await openWatch(port, id);

    const stop = agent.stop({ timeoutMs: 800 });
    let failure: Error | undefined;
    try {
      await settlesWithin(stop, 3000);
    } catch (error) {
      failure = error as Error;
    }
    watch.close();
    untrack(agent);
    await settlesWithin(stop, 3000).catch(() => {});
    if (failure) throw failure;

    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
    expect(watch.readyState).not.toBe(WebSocket.OPEN);
  });

  it("refuses an upgrade still in flight when stop starts", async () => {
    const plugin = definePlugin("slow", () => ({
      routes(app, ctx) {
        app.get(
          "/slow",
          ctx.upgradeWebSocket(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return {};
          }),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const url = `ws://127.0.0.1:${port}/plugins/slow/slow`;

    const opening = new Promise<WebSocket | Error>((resolve) => {
      const socket = new WebSocket(url, { headers: authHeaders });
      socket.once("open", () => resolve(socket));
      socket.once("error", (error) => resolve(error));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stop = agent.stop({ timeoutMs: 1000 });
    await settlesWithin(stop, 3000);
    untrack(agent);

    const client = await opening;
    if (client instanceof WebSocket) client.close();
    expect(client).toBeInstanceOf(Error);
    expect((client as Error).message).toMatch(/503/);
    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
  });

  it("terminates plugin sockets and settles when a watch socket is also open", async () => {
    const plugin = definePlugin("a", () => ({
      routes(app, ctx) {
        app.get(
          "/stuck",
          ctx.upgradeWebSocket(() => ({})),
        );
      },
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }));
    const { port } = await agent.listen(0);
    const { id } = await agent.host.createConversation();

    const { response, socket } = await rawUpgrade(port, "/plugins/a/stuck");
    expect(response.statusCode).toBe(101);
    socket.pause();
    const watch = await openWatch(port, id);

    const stop = agent.stop({ timeoutMs: 500 });
    const outcome = await settlesWithin(
      stop.then(
        () => undefined,
        (error: Error) => error,
      ),
      3000,
    ).catch((error: Error) => error);
    watch.close();
    socket.resume();
    socket.destroy();
    untrack(agent);
    await settlesWithin(stop, 3000).catch(() => {});

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/still running: plugin socket "a"/);
    expect(existsSync(`${engineOf(agent).path}.lock`)).toBe(false);
  });
});
