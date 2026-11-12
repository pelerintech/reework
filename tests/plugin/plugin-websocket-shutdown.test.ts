// Plugin WebSocket shutdown: sockets that never confirm a close are counted
// like other unfinished work, and the stop deadline names them.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import { engineOf } from "@reework/core/internal";
import { TEST_TOKEN, startTestAgent, testDefinition, untrack } from "../support/agent.ts";
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
});
