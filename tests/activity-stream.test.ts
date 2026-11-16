import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ActivityFrame } from "@reework/types";
import { Type, definePlugin, defineTool, gatedAction } from "@reework/core";
import { waitForProposal } from "@reework/core/testing";
import { authHeaders, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

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
});
