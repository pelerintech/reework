import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ActivityFrame } from "@reework/types";
import { definePlugin, gatedAction } from "@reework/core";
import { activityWatcherCount } from "@reework/core/testing";
import { authHeaders, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

// A snapshot larger than the socket's send buffer, so a paused client leaves
// buffered bytes on the server side. A later small event then overflows in the
// flush path rather than at enqueue.
const HUGE_TITLE = "slow ".repeat(4_000_000);
const MAX_BUFFERED_BYTES = 1000;

function deployTool() {
  return gatedAction({
    name: "deploy",
    gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
    run: async () => "deployed",
  });
}

async function slowAgent() {
  const faux = fauxModels();
  faux.respond([
    fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("waiting"),
    fauxAssistantMessage("still runs answer"),
  ]);
  const plugin = definePlugin("ops", () => ({ tools: [deployTool()] }));
  const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
    models: faux.models,
    activity: { maxBufferedBytes: MAX_BUFFERED_BYTES },
  });
  const { port } = await agent.listen(0);
  const conversation = await agent.host.createConversation({
    key: "slow/a",
    case: { title: HUGE_TITLE },
  });
  // Open a proposal so the case (with its huge title) is in the snapshot.
  await agent.host.submitInput(conversation.id, "deploy", { wait: true });
  return { agent, port, conversation, faux };
}

/** An agent whose per-subscriber queue bound is exceeded before the socket buffer. */
async function queueBoundAgent() {
  const faux = fauxModels();
  faux.respond([fauxAssistantMessage("still runs answer")]);
  const agent = await startTestAgent(testDefinition(), {
    models: faux.models,
    activity: { maxBufferedBytes: 1 },
  });
  const { port } = await agent.listen(0);
  const conversation = await agent.host.createConversation({ key: "queue/a" });
  return { agent, port, conversation };
}

/** Hold the snapshot until the client has opened and paused its socket. */
function holdSnapshot(agent: Awaited<ReturnType<typeof slowAgent>>["agent"]): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = agent.host.activitySnapshot.bind(agent.host);
  agent.host.activitySnapshot = async (filter) => {
    await gate;
    return original(filter);
  };
  return release;
}

interface Client {
  readonly socket: WebSocket;
  readonly frames: ActivityFrame[];
  readonly closed: Promise<{ code: number; reason: string }>;
  next(): Promise<ActivityFrame>;
  close(): Promise<void>;
}

function connect(port: number, paused: boolean, query = ""): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/activity/ws${query}`, {
    headers: authHeaders,
  });
  const frames: ActivityFrame[] = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse((data as Buffer).toString("utf8")) as ActivityFrame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      if (paused) socket.pause();
      let cursor = 0;
      resolve({
        socket,
        frames,
        closed,
        async next() {
          while (frames.length <= cursor) await new Promise((done) => setTimeout(done, 10));
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

/** The server-side buffered bytes of the hub's first subscriber. */
function bufferedBytes(agent: Awaited<ReturnType<typeof slowAgent>>["agent"]): number {
  const hub = (
    agent as unknown as {
      activityHub: {
        subscribers: Map<string, { raw?: { bufferedAmount: number } }>;
      };
    }
  ).activityHub;
  return [...hub.subscribers.values()][0]?.raw?.bufferedAmount ?? 0;
}

describe("the activity stream's slow-client policy", () => {
  it("releases watchers when the flush path overflows, without a later publish", async () => {
    const { agent, port, conversation, faux } = await slowAgent();
    const release = holdSnapshot(agent);
    const slow = await connect(port, true, "?keyPrefix=slow%2F");
    release();
    await eventually(() => activityWatcherCount(agent) === 1);
    // The paused client has now left the huge snapshot buffered on the server,
    // so the next small event overflows in flush rather than at enqueue.
    await eventually(() => bufferedBytes(agent) > MAX_BUFFERED_BYTES);

    await agent.host.updateCase(conversation.id, { status: "waiting" });
    await eventually(() => activityWatcherCount(agent) === 0);
    slow.socket.resume();
    expect(await slow.closed).toEqual({ code: 1008, reason: "slow consumer" });
    // No publish after the overflow: the release above came from overflow itself.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(activityWatcherCount(agent)).toBe(0);

    faux.append([fauxAssistantMessage("still runs answer")]);
    const fresh = await agent.host.createConversation();
    const result = await agent.host.submitInput(fresh.id, "still runs", { wait: true });
    expect(JSON.stringify(result.message)).toContain("still runs answer");
    const health = await agent.app.request("/health");
    expect(health.status).toBe(200);
  }, 15_000);

  it("closes an overflowing queue with 1008 and releases watchers without a later publish", async () => {
    const { agent, port, conversation } = await queueBoundAgent();
    const client = await connect(port, false);
    expect((await client.next()).kind).toBe("snapshot");
    expect(activityWatcherCount(agent)).toBe(1);

    await agent.host.updateCase(conversation.id, { status: "waiting" });
    expect(await client.closed).toEqual({ code: 1008, reason: "slow consumer" });
    await eventually(() => activityWatcherCount(agent) === 0);
    // No publish after the overflow: the queue bound itself released the watcher.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(activityWatcherCount(agent)).toBe(0);

    const fresh = await agent.host.createConversation();
    const result = await agent.host.submitInput(fresh.id, "still runs", { wait: true });
    expect(JSON.stringify(result.message)).toContain("still runs answer");
    const health = await agent.app.request("/health");
    expect(health.status).toBe(200);
  }, 15_000);

  it("drops one slow subscriber and keeps the healthy subscriber's watcher and stream", async () => {
    const { agent, port, conversation } = await slowAgent();
    const fast = await agent.host.createConversation({ key: "fast/a" });
    const release = holdSnapshot(agent);
    const slow = await connect(port, true, "?keyPrefix=slow%2F");
    release();
    await eventually(() => activityWatcherCount(agent) === 1);
    await eventually(() => bufferedBytes(agent) > MAX_BUFFERED_BYTES);

    const healthy = await connect(port, false, "?keyPrefix=fast%2F");
    expect((await healthy.next()).kind).toBe("snapshot");
    expect(activityWatcherCount(agent)).toBe(2);

    await agent.host.updateCase(conversation.id, { status: "waiting" });
    slow.socket.resume();
    expect(await slow.closed).toEqual({ code: 1008, reason: "slow consumer" });
    expect(activityWatcherCount(agent)).toBe(1);

    await agent.host.updateCase(fast.id, { status: "waiting" });
    expect(await healthy.next()).toMatchObject({
      kind: "event",
      event: { kind: "case_changed", conversationId: fast.id, status: "waiting" },
    });
    expect(activityWatcherCount(agent)).toBe(1);

    await agent.host.updateCase(fast.id, { status: "open" });
    expect(await healthy.next()).toMatchObject({
      kind: "event",
      event: { kind: "case_changed", conversationId: fast.id, status: "open" },
    });
    expect(activityWatcherCount(agent)).toBe(1);

    await healthy.close();
    await eventually(() => activityWatcherCount(agent) === 0);
  }, 15_000);
});
