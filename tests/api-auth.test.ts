import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestAgent, testDefinition } from "./support/agent.ts";

const TOKEN = "s3cret-token";
const SUPPORT_TOKEN = process.env.REEWORK_API_TOKEN;

afterEach(() => {
  process.env.REEWORK_API_TOKEN = SUPPORT_TOKEN;
});

function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => {});
  });
}

describe("API token", () => {
  it("rejects built-in routes without the right bearer token, over REST and WebSocket", async () => {
    process.env.REEWORK_API_TOKEN = TOKEN;
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const { id } = await agent.host.createConversation();

    expect((await fetch(`${base}/conversations`)).status).toBe(401);
    expect(
      (await fetch(`${base}/conversations`, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/conversations`, { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(200);

    const ws = `ws://127.0.0.1:${port}/conversations/${id}/ws`;
    expect(await upgradeStatus(ws)).toBe(401);
    expect(await upgradeStatus(ws, { authorization: `Bearer ${TOKEN}` })).toBe(101);
  });

  it("keeps /health open", async () => {
    process.env.REEWORK_API_TOKEN = TOKEN;
    const agent = await startTestAgent(testDefinition());
    expect((await agent.app.request("/health")).status).toBe(200);
  });

  it("stops startup naming the token variable when it is not set", async () => {
    delete process.env.REEWORK_API_TOKEN;
    await expect(startTestAgent(testDefinition())).rejects.toThrow(/REEWORK_API_TOKEN/);
  });
});
