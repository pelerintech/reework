import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { openActivityStream, startTestAgent, text } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";
import { testDefinition } from "./support/agent.ts";

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

describe("testing kit: the activity stream", () => {
  it("opens a stream with the test token and filters, then closes its listener", async () => {
    const test = await startTestAgent(testDefinition());
    const listener = captureListener(test);
    try {
      const conversation = await test.agent.host.createConversation({ key: "team/a" });
      await test.agent.host.updateCase(conversation.id, { tags: ["ops"] });
      test.model.respond([text("answer")]);
      const client = await openActivityStream(test, { keyPrefix: "team/", tag: ["ops"] });
      expect(client.port).toBeGreaterThan(0);
      expect(client.frames[0]).toMatchObject({
        kind: "snapshot",
        snapshot: { filter: { keyPrefix: "team/", tag: ["ops"] } },
      });

      await test.agent.host.submitInput(conversation.id, "go", { wait: true });
      const frame = await client.next();
      expect(frame.kind).toBe("event");
      if (frame.kind !== "event") throw new Error("expected an event frame");
      if (frame.event.kind === "agent_state") throw new Error("expected a conversation event");
      expect(frame.event.conversationId).toBe(conversation.id);
      await client.close();
      const handle = listener();
      expect(handle).toBeDefined();
      expect(await acceptsTcp(handle!.port)).toBe(false);
    } finally {
      await listener()
        ?.close()
        .catch(() => {});
      await test.dispose();
    }
  });

  it("rejects a wrong token and closes the listener it opened", async () => {
    const test = await startTestAgent(testDefinition());
    const listener = captureListener(test);
    try {
      await expect(openActivityStream(test, { token: "wrong" })).rejects.toThrow(/401/);
      const handle = listener();
      expect(handle).toBeDefined();
      expect(await acceptsTcp(handle!.port)).toBe(false);
    } finally {
      await listener()
        ?.close()
        .catch(() => {});
      await test.dispose();
    }
  });
});
