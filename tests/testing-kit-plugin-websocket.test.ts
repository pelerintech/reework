// The testing kit drives a plugin WebSocket against a real in-process agent,
// with no port bookkeeping in the test.
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { openPluginWebSocket, startTestAgent } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import { untrack } from "./support/agent.ts";

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "socket-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You serve sockets." },
  };
}

type ListenHandle = Awaited<ReturnType<TestAgent["agent"]["listen"]>>;

/** Record the handle the helper listens with, so a leaked listener can be closed. */
function captureListener(test: TestAgent): () => ListenHandle | undefined {
  let handle: ListenHandle | undefined;
  const listen = test.agent.listen.bind(test.agent);
  test.agent.listen = async (port, hostname) => {
    handle = await listen(port, hostname);
    return handle;
  };
  return () => handle;
}

/** Settle a promise within `ms`, so a hung cleanup fails the test instead of hanging it. */
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

/** Whether a listener still accepts TCP connections on `port`. */
function acceptsTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

describe("testing kit: plugin websockets", () => {
  it("opens a plugin socket with the test agent's token", async () => {
    const plugin = definePlugin("echo", () => ({
      routes(app, ctx) {
        app.get(
          "/echo",
          ctx.upgradeWebSocket(() => ({
            onMessage(
              data: string | Uint8Array,
              socket: { send(data: string | Uint8Array): void },
            ) {
              socket.send(`echo:${typeof data === "string" ? data : data.byteLength}`);
            },
          })),
        );
      },
    }));
    const test = await startTestAgent(definition([{ plugin, config: {} }]));

    const client = await openPluginWebSocket(test, "/plugins/echo/echo");
    expect(client.port).toBeGreaterThan(0);
    const message = new Promise<string>((resolve) => {
      client.socket.once("message", (data) => resolve((data as Buffer).toString("utf8")));
    });
    client.socket.send("hi");
    expect(await message).toBe("echo:hi");
    await client.close();
    await test.dispose();
  });

  it("surfaces a refused handshake and accepts the plugin's own secret", async () => {
    const plugin = definePlugin("hookin", () => ({
      routes(app, ctx) {
        app.get(
          "/open/inbound",
          ctx.upgradeWebSocket(async (c) => {
            if (c.req.query("secret") !== "s3") return c.json({ error: "unauthorized" }, 401);
            return {};
          }),
        );
      },
    }));
    const test = await startTestAgent(definition([{ plugin, config: {} }]));

    await expect(openPluginWebSocket(test, "/plugins/hookin/open/inbound")).rejects.toThrow(/401/);
    const client = await openPluginWebSocket(test, "/plugins/hookin/open/inbound?secret=s3");
    await client.close();
    await test.dispose();
  });

  it("closes its listener when the handshake is refused", async () => {
    const plugin = definePlugin("hookin", () => ({
      routes(app, ctx) {
        app.get(
          "/open/inbound",
          ctx.upgradeWebSocket(async (c) => {
            if (c.req.query("secret") !== "s3") return c.json({ error: "unauthorized" }, 401);
            return {};
          }),
        );
      },
    }));
    const test = await startTestAgent(definition([{ plugin, config: {} }]));
    const listener = captureListener(test);
    try {
      await expect(openPluginWebSocket(test, "/plugins/hookin/open/inbound")).rejects.toThrow(
        /401/,
      );
      const handle = listener();
      expect(handle).toBeDefined();
      expect(await acceptsTcp(handle!.port)).toBe(false);
    } finally {
      await listener()
        ?.close()
        .catch(() => {});
    }
  });

  it("closes its listener and pending upgrade when the handshake times out", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plugin = definePlugin("hang", () => ({
      routes(app, ctx) {
        app.get(
          "/open/hang",
          ctx.upgradeWebSocket(async () => {
            await gate;
            return {};
          }),
        );
      },
    }));
    const test = await startTestAgent(definition([{ plugin, config: {} }]));
    const listener = captureListener(test);
    let failure: Error | undefined;
    try {
      await expect(
        openPluginWebSocket(test, "/plugins/hang/open/hang", { timeoutMs: 300 }),
      ).rejects.toThrow(/timed out/i);
      const handle = listener();
      expect(handle).toBeDefined();
      expect(await acceptsTcp(handle!.port)).toBe(false);
    } catch (error) {
      failure = error as Error;
    }
    release();
    await settlesWithin(test.agent.stop({ timeoutMs: 1000 }), 3000).catch(() => {});
    untrack(test.agent);
    if (failure) throw failure;
  });
});
