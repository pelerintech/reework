import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ActivityFrame } from "@reework/types";
import { Type, definePlugin, defineTool, gatedAction } from "@reework/core";
import { activityWatcherCount, waitForProposal } from "@reework/core/testing";
import {
  authHeaders,
  fauxModels,
  startTestAgent,
  testDefinition,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

interface ActivityClient {
  readonly socket: WebSocket;
  readonly frames: ActivityFrame[];
  next(): Promise<ActivityFrame>;
  close(): Promise<void>;
}

async function nextEvent(
  client: ActivityClient,
  conversationId: string,
  kind: string,
): Promise<Extract<ActivityFrame, { kind: "event" }>["event"]> {
  for (;;) {
    const frame = await client.next();
    if (
      frame.kind === "event" &&
      frame.event.conversationId === conversationId &&
      frame.event.kind === kind
    ) {
      return frame.event;
    }
  }
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

/** A tool that blocks until released (or the run is aborted). */
function slowTool() {
  const waiters: (() => void)[] = [];
  let starts = 0;
  const tool = defineTool({
    name: "slow",
    description: "Takes a while.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      starts += 1;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        waiters.push(resolve);
      });
      return "slow done";
    },
  });
  return {
    tool,
    release: () => {
      for (const waiter of waiters.splice(0)) waiter();
    },
    releaseNext: () => waiters.shift()?.(),
    started: () => starts,
  };
}

function deployTool() {
  return gatedAction({
    name: "deploy",
    gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
    run: async () => "deployed",
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

  it("lists open work in the snapshot and replays it on reconnect", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool, deployTool()] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage("slow done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation({ key: "ops/1" });
    const b = await agent.host.createConversation();

    const before = await connectActivity(port, "/activity/ws");
    const beforeFrame = await before.next();
    if (beforeFrame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(beforeFrame.snapshot).toMatchObject({ runs: [], proposals: [], cases: [] });
    await before.close();

    await agent.host.submitInput(a.id, "run the slow tool");
    await eventually(() => slow.started());
    await agent.host.submitInput(b.id, "deploy it");
    const proposal = await waitForProposal(agent.host, b.id);

    const client = await connectActivity(port, "/activity/ws");
    const frame = await client.next();
    if (frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    const snapshot = frame.snapshot;
    expect(snapshot.runs).toEqual([
      expect.objectContaining({ conversationId: a.id, key: "ops/1", caseKind: "case" }),
    ]);
    expect(typeof snapshot.runs[0]!.runId).toBe("string");
    expect(snapshot.proposals).toContainEqual(
      expect.objectContaining({
        id: proposal.id,
        conversationId: b.id,
        title: "Deploy?",
        audience: "human",
        options: [{ id: "go", label: "Deploy" }],
      }),
    );
    expect(snapshot.cases).toContainEqual(
      expect.objectContaining({ id: b.id, needsHuman: true, openProposals: 1 }),
    );
    slow.release();
    await client.close();
  });

  it("announces a run ending with its identity and outcome", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    const answer = (context: { messages: { role: string; content: unknown }[] }) => {
      const prompt = JSON.stringify(context.messages);
      return prompt.includes("B-run")
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" })
        : fauxAssistantMessage("done");
    };
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      answer,
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation({ key: "run/a" });
    const b = await agent.host.createConversation({ key: "run/b" });
    const submittedA = await agent.host.submitInput(a.id, "A-run");
    const submittedB = await agent.host.submitInput(b.id, "B-run");
    await eventually(() => slow.started() >= 2);

    const client = await connectActivity(port, "/activity/ws");
    await client.next();

    slow.releaseNext();
    let endedA: Extract<ActivityFrame, { kind: "event" }> | undefined;
    while (endedA === undefined) {
      const frame = await client.next();
      if (
        frame.kind === "event" &&
        frame.event.kind === "run_ended" &&
        frame.event.conversationId === a.id
      ) {
        endedA = frame;
      }
    }
    expect(endedA.event).toMatchObject({
      conversationId: a.id,
      key: "run/a",
      caseKind: "case",
      runId: submittedA.submissionId,
      outcome: "completed",
    });

    slow.releaseNext();
    let endedB: Extract<ActivityFrame, { kind: "event" }> | undefined;
    while (endedB === undefined) {
      const frame = await client.next();
      if (
        frame.kind === "event" &&
        frame.event.kind === "run_ended" &&
        frame.event.conversationId === b.id
      ) {
        endedB = frame;
      }
    }
    expect(endedB.event).toMatchObject({
      conversationId: b.id,
      key: "run/b",
      caseKind: "case",
      runId: submittedB.submissionId,
      outcome: "unanswered",
    });
    await client.close();
  });

  it("keeps observing an idle conversation and closes cleanly on stop", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("later answer")]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation({ key: "desk/idle" });

    const client = await connectActivity(port, "/activity/ws");
    const snapshotFrame = await client.next();
    if (snapshotFrame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(snapshotFrame.snapshot.runs).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    const pong = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pong")), 2000);
      client.socket.once("pong", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    client.socket.ping();
    await pong;

    await agent.host.submitInput(conversation.id, "wake up");
    const kinds: string[] = [];
    while (!(kinds.includes("run_started") && kinds.includes("run_ended"))) {
      const frame = await client.next();
      if (frame.kind === "event" && frame.event.conversationId === conversation.id) {
        kinds.push(frame.event.kind);
      }
    }

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await agent.stop();
    untrack(agent);
    expect(await closed).toEqual({ code: 1001, reason: "agent stopping" });
  });

  it("watches open work, detaches a closed case and reattaches a reopened one", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage("again done"),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("after slow"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation();

    const first = await connectActivity(port, "/activity/ws");
    await first.next();
    expect(activityWatcherCount(agent)).toBe(1);

    await agent.host.updateCase(a.id, { status: "closed" });
    expect(await nextEvent(first, a.id, "case_changed")).toMatchObject({ status: "closed" });
    expect(activityWatcherCount(agent)).toBe(0);

    await agent.host.submitInput(a.id, "again");
    await eventually(() => activityWatcherCount(agent) === 1);
    expect(await nextEvent(first, a.id, "case_changed")).toMatchObject({ status: "open" });
    expect(await nextEvent(first, a.id, "run_started")).toMatchObject({ caseKind: "case" });
    expect(await nextEvent(first, a.id, "run_ended")).toMatchObject({ outcome: "completed" });

    await agent.host.submitInput(a.id, "slow run");
    expect(await nextEvent(first, a.id, "case_changed")).toMatchObject({ status: "open" });
    await eventually(() => slow.started() === 1);
    expect(activityWatcherCount(agent)).toBe(1);

    await agent.host.updateCase(a.id, { status: "closed" });
    expect(await nextEvent(first, a.id, "case_changed")).toMatchObject({ status: "closed" });
    expect(activityWatcherCount(agent)).toBe(1);

    const second = await connectActivity(port, "/activity/ws");
    const secondFrame = await second.next();
    if (secondFrame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(secondFrame.snapshot.runs).toEqual([]);
    expect(activityWatcherCount(agent)).toBe(1);

    slow.release();
    expect(await nextEvent(first, a.id, "run_ended")).toMatchObject({ outcome: "completed" });
    await eventually(() => activityWatcherCount(agent) === 0);
    await first.close();
    await second.close();
  });

  it("announces tool starts and finishes without their content", async () => {
    const plugin = definePlugin("tools", () => ({
      tools: [
        defineTool({
          name: "lookup",
          description: "Look something up.",
          parameters: Type.Object({ q: Type.String() }),
          execute: async () => "OUT-MARKER",
        }),
        defineTool({
          name: "broken",
          description: "Always fails.",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => {
            throw new Error("boom");
          },
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage(
        [fauxToolCall("lookup", { q: "ARG-MARKER" }), fauxToolCall("broken", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation();
    const client = await connectActivity(port, "/activity/ws");
    await client.next();

    await agent.host.submitInput(conversation.id, "use the tools", { wait: true });
    await eventually(() =>
      client.frames.some(
        (frame) =>
          frame.kind === "event" &&
          frame.event.kind === "tool_finished" &&
          frame.event.name === "broken",
      ),
    );
    const events = client.frames
      .filter((frame): frame is Extract<ActivityFrame, { kind: "event" }> => frame.kind === "event")
      .map((frame) => frame.event);
    const lookupStart = events.find((e) => e.kind === "tool_started" && e.name === "lookup");
    const lookupCallId = lookupStart?.kind === "tool_started" ? lookupStart.callId : undefined;
    const lookupEnd = events.find((e) => e.kind === "tool_finished" && e.name === "lookup");
    const brokenEnd = events.find((e) => e.kind === "tool_finished" && e.name === "broken");
    expect(lookupStart).toMatchObject({ kind: "tool_started", callId: expect.any(String) });
    expect(lookupEnd).toMatchObject({
      kind: "tool_finished",
      callId: lookupCallId,
      status: "done",
    });
    expect((lookupEnd as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0);
    expect(brokenEnd).toMatchObject({ kind: "tool_finished", status: "error" });
    expect(JSON.stringify(client.frames)).not.toContain("ARG-MARKER");
    expect(JSON.stringify(client.frames)).not.toContain("OUT-MARKER");
    expect(events.some((e) => e.kind.startsWith("message_"))).toBe(false);
    for (const event of events.filter((e) => e.kind.startsWith("tool_"))) {
      expect(event).not.toHaveProperty("arguments");
      expect(event).not.toHaveProperty("output");
      expect(event).not.toHaveProperty("result");
    }
    await client.close();
  });
});
