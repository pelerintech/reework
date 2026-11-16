import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ActivityFrame } from "@reework/types";
import { authHeaders, startTestAgent, testDefinition } from "./support/agent.ts";

interface ActivityClient {
  readonly socket: WebSocket;
  readonly frames: ActivityFrame[];
  next(): Promise<ActivityFrame>;
  close(): Promise<void>;
}

/** A ws client that collects parsed activity frames and resolves the next one. */
function connectActivity(
  port: number,
  path: string,
  headers: Record<string, string> = authHeaders,
): Promise<ActivityClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const frames: ActivityFrame[] = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse((data as Buffer).toString("utf8")) as ActivityFrame);
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      let cursor = 0;
      resolve({
        socket,
        frames,
        async next() {
          while (frames.length <= cursor) {
            await new Promise((done) => setTimeout(done, 10));
          }
          return frames[cursor++]!;
        },
        async close() {
          if (socket.readyState === WebSocket.CLOSED) return;
          await new Promise<void>((done) => {
            socket.once("close", () => done());
            socket.close();
          });
        },
      });
    });
    socket.once("error", reject);
  });
}

describe("the activity stream", () => {
  it("answers with a snapshot behind the token", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);

    const client = await connectActivity(port, "/activity/ws");
    expect(await client.next()).toMatchObject({
      kind: "snapshot",
      snapshot: { runs: [], proposals: [], cases: [] },
    });
    await client.close();

    await expect(connectActivity(port, "/activity/ws", {})).rejects.toThrow(/401/);
    await expect(
      connectActivity(port, "/activity/ws", { authorization: "Bearer wrong" }),
    ).rejects.toThrow(/401/);
  });
});
