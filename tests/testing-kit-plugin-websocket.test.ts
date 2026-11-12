// The testing kit drives a plugin WebSocket against a real in-process agent,
// with no port bookkeeping in the test.
import { describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { openPluginWebSocket, startTestAgent } from "@reework/core/testing";

function definition(plugins: AgentDefinition["plugins"]): AgentDefinition {
  return {
    name: "socket-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins,
    channels: [],
    mission: { role: "You serve sockets." },
  };
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
});
