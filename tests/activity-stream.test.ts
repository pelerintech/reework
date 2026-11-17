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
import { startFakeLlm } from "./support/fake-llm.ts";
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
        proposalId: proposal.id,
        conversationId: b.id,
        title: "Deploy?",
        audience: "human",
        options: [{ id: "go", label: "Deploy" }],
      }),
    );
    expect(snapshot.cases).toContainEqual(
      expect.objectContaining({ conversationId: b.id, needsHuman: true, openProposals: 1 }),
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

  it("stops an attach that finishes after agent.stop", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    await agent.host.createConversation({ key: "desk/attach" });
    const hub = (
      agent as unknown as {
        activityHub: {
          doAttach: (id: string) => Promise<void>;
          close: () => Promise<void>;
        };
      }
    ).activityHub;

    let attachEntered!: () => void;
    const attachEnteredP = new Promise<void>((resolve) => (attachEntered = resolve));
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => (releaseAttach = resolve));
    let attachDone!: () => void;
    const attachDoneP = new Promise<void>((resolve) => (attachDone = resolve));
    const originalDoAttach = hub.doAttach.bind(hub);
    hub.doAttach = async (id) => {
      attachEntered();
      await attachGate;
      const result = await originalDoAttach(id);
      attachDone();
      return result;
    };
    let closeEntered!: () => void;
    const closeEnteredP = new Promise<void>((resolve) => (closeEntered = resolve));
    const originalClose = hub.close.bind(hub);
    hub.close = async () => {
      closeEntered();
      return originalClose();
    };

    const client = await connectActivity(port, "/activity/ws");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await attachEnteredP;
    const stopping = agent.stop();
    untrack(agent);
    await closeEnteredP;
    releaseAttach();
    await attachDoneP;
    expect(activityWatcherCount(agent)).toBe(0);
    await stopping;
    expect(await closed).toEqual({ code: 1001, reason: "agent stopping" });
    expect(activityWatcherCount(agent)).toBe(0);
    expect(client.frames).toEqual([]);
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

  it("never carries conversation or gate content", async () => {
    const plugin = definePlugin("content", () => ({
      tools: [
        defineTool({
          name: "lookup",
          description: "Look something up.",
          parameters: Type.Object({ q: Type.String() }),
          execute: async () => "OUT-MARKER",
        }),
        gatedAction({
          name: "deploy",
          gate: {
            title: "Deploy?",
            description: "DESCRIPTION-MARKER",
            options: [{ id: "go", label: "Go" }],
            attachments: [{ kind: "diff", content: "ATTACHMENT-MARKER" }],
          },
          run: async () => "deployed",
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage(
        [fauxToolCall("lookup", { q: "ARG-MARKER" }), fauxToolCall("deploy", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation({
      key: "content/1",
      case: { title: "Visible title" },
    });

    const live = await connectActivity(port, "/activity/ws");
    await live.next();
    await agent.host.submitInput(conversation.id, "TEXT-MARKER", { wait: true });
    const proposal = await waitForProposal(agent.host, conversation.id);
    await agent.host.updateCase(conversation.id, {
      summary: "SUMMARY-MARKER",
      tags: ["private-tag"],
    });
    await eventually(() =>
      live.frames.some((frame) => frame.kind === "event" && frame.event.kind === "proposal_opened"),
    );

    const replay = await connectActivity(port, "/activity/ws");
    const snapshotFrame = await replay.next();
    if (snapshotFrame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    const snapshot = snapshotFrame.snapshot;
    const frames = [...live.frames, ...replay.frames];
    const serialized = JSON.stringify(frames);
    for (const marker of [
      "TEXT-MARKER",
      "ARG-MARKER",
      "OUT-MARKER",
      "SUMMARY-MARKER",
      "DESCRIPTION-MARKER",
      "ATTACHMENT-MARKER",
    ]) {
      expect(serialized).not.toContain(marker);
    }

    const opened = live.frames.find(
      (frame): frame is Extract<ActivityFrame, { kind: "event" }> =>
        frame.kind === "event" && frame.event.kind === "proposal_opened",
    );
    expect(opened?.event).toMatchObject({
      proposalId: proposal.id,
      title: "Deploy?",
      options: [{ id: "go", label: "Go" }],
      audience: "human",
    });
    expect(opened?.event).not.toHaveProperty("description");
    expect(opened?.event).not.toHaveProperty("attachments");

    const snapshotProposal = snapshot.proposals.find((p) => p.proposalId === proposal.id);
    expect(snapshotProposal).toMatchObject({
      proposalId: proposal.id,
      title: "Deploy?",
      options: [{ id: "go", label: "Go" }],
    });
    expect(snapshotProposal).not.toHaveProperty("description");
    expect(snapshotProposal).not.toHaveProperty("attachments");

    const snapshotCase = snapshot.cases.find((c) => c.conversationId === conversation.id);
    expect(snapshotCase).toMatchObject({
      title: "Visible title",
      status: "open",
      priority: "normal",
      needsHuman: true,
      openProposals: 1,
    });
    expect(snapshotCase).not.toHaveProperty("summary");
    expect(snapshotCase).not.toHaveProperty("tags");

    const caseEvents = live.frames
      .filter(
        (frame): frame is Extract<ActivityFrame, { kind: "event" }> =>
          frame.kind === "event" && frame.event.kind === "case_changed",
      )
      .map((frame) => frame.event);
    expect(caseEvents.length).toBeGreaterThan(0);
    for (const event of caseEvents) {
      expect(event).not.toHaveProperty("title");
      expect(event).not.toHaveProperty("summary");
      expect(event).not.toHaveProperty("tags");
    }
    await live.close();
    await replay.close();
  });

  it("announces a proposal opening and settling", async () => {
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
          run: async () => "deployed",
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting on you"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation({ key: "gate/1" });
    const client = await connectActivity(port, "/activity/ws");
    await client.next();

    await agent.host.submitInput(conversation.id, "deploy it");
    const proposal = await waitForProposal(agent.host, conversation.id);
    expect(await nextEvent(client, conversation.id, "proposal_opened")).toMatchObject({
      proposalId: proposal.id,
      conversationId: conversation.id,
      key: "gate/1",
      caseKind: "case",
      title: "Deploy?",
      options: [{ id: "go", label: "Deploy" }],
      audience: "human",
    });

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: "INSTRUCTION-MARKER",
      decidedBy: { kind: "human", name: "Ana" },
    });
    expect(await nextEvent(client, conversation.id, "proposal_settled")).toMatchObject({
      proposalId: proposal.id,
      audience: "human",
      selectedOption: "go",
      decidedBy: { kind: "human", name: "Ana" },
    });
    expect(JSON.stringify(client.frames)).not.toContain("INSTRUCTION-MARKER");
    await client.close();
  });

  it("announces case fields and the human need proposals create", async () => {
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "deploy",
          gate: { title: "Deploy?", options: [{ id: "go", label: "Deploy" }] },
          run: async () => "deployed",
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting on you"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation();
    const client = await connectActivity(port, "/activity/ws");
    await client.next();

    await agent.host.updateCase(conversation.id, {
      status: "waiting",
      stage: "triage",
      priority: "high",
      owner: { kind: "human", name: "Ana" },
    });
    const updated = await nextEvent(client, conversation.id, "case_changed");
    expect(updated).toMatchObject({
      status: "waiting",
      stage: "triage",
      priority: "high",
      owner: { kind: "human", name: "Ana" },
      needsHuman: false,
      openProposals: 0,
    });
    expect(updated).not.toHaveProperty("title");
    expect(updated).not.toHaveProperty("summary");
    expect(updated).not.toHaveProperty("tags");

    await agent.host.submitInput(conversation.id, "deploy it");
    const proposal = await waitForProposal(agent.host, conversation.id);
    await nextEvent(client, conversation.id, "case_changed");
    await nextEvent(client, conversation.id, "proposal_opened");
    expect(await nextEvent(client, conversation.id, "case_changed")).toMatchObject({
      needsHuman: true,
      openProposals: 1,
    });

    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
      decidedBy: { kind: "human", name: "Ana" },
    });
    await nextEvent(client, conversation.id, "proposal_settled");
    expect(await nextEvent(client, conversation.id, "case_changed")).toMatchObject({
      needsHuman: false,
      openProposals: 0,
    });
    await client.close();
  });

  it("reports model usage per conversation and never agent-level", async () => {
    const llm = await startFakeLlm();
    process.env.REEWORK_TEST_LLM_KEY = "k";
    const helper = definePlugin(
      "helper",
      () => ({
        async setup(ctx) {
          await ctx.models.complete("fast", { messages: "setup" });
        },
        routes(app, ctx) {
          app.post("/usage", async (c) => {
            await ctx.models.complete("fast", { messages: "route" });
            return c.json({ ok: true });
          });
        },
      }),
      { models: ["fast"] },
    );
    llm.script(
      { text: "setup", usage: { input: 1, output: 1 } },
      { text: "route", usage: { input: 2, output: 2 } },
      { text: "done", usage: { input: 120, output: 30 } },
    );
    const definition = testDefinition({
      model: {
        provider: { baseUrl: llm.url, apiKeyEnv: "REEWORK_TEST_LLM_KEY" },
        modelId: "m1",
      },
      models: {
        fast: {
          provider: { baseUrl: llm.url, apiKeyEnv: "REEWORK_TEST_LLM_KEY" },
          modelId: "fast-model",
        },
      },
      plugins: [{ plugin: helper, config: {} }],
    });
    const agent = await startTestAgent(definition, { models: undefined });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation();
    const client = await connectActivity(port, "/activity/ws");
    await client.next();

    const route = await agent.app.request("/plugins/helper/usage", {
      method: "POST",
      headers: { authorization: authHeaders.authorization },
    });
    expect(route.status).toBe(200);
    await agent.host.submitInput(conversation.id, "go", { wait: true });
    await eventually(() =>
      client.frames.some(
        (frame) =>
          frame.kind === "event" &&
          frame.event.kind === "model_usage" &&
          frame.event.conversationId === conversation.id,
      ),
    );
    const usageEvents = client.frames
      .filter((frame): frame is Extract<ActivityFrame, { kind: "event" }> => frame.kind === "event")
      .map((frame) => frame.event)
      .filter((event) => event.kind === "model_usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      conversationId: conversation.id,
      source: "run",
      model: "main",
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(JSON.stringify(client.frames)).not.toContain('"source":"plugin"');
    await client.close();
  });

  it("scopes the snapshot and the stream by key prefix", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool, deployTool()] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {}), fauxToolCall("deploy", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage("done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation({ key: "team/a" });
    const b = await agent.host.createConversation({ key: "desk/private" });
    const c = await agent.host.createConversation();
    await agent.host.submitInput(a.id, "run and propose");
    await eventually(() => slow.started() === 1);
    const proposalA = await waitForProposal(agent.host, a.id);
    await agent.host.submitInput(b.id, "deploy b", { wait: true });
    const proposalB = await waitForProposal(agent.host, b.id);
    await agent.host.submitInput(c.id, "deploy c", { wait: true });
    const proposalC = await waitForProposal(agent.host, c.id);

    const client = await connectActivity(port, "/activity/ws?keyPrefix=team%2F");
    const frame = await client.next();
    if (frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(frame.snapshot.filter).toEqual({ keyPrefix: "team/" });
    expect(frame.snapshot.runs).toEqual([
      expect.objectContaining({ conversationId: a.id, key: "team/a" }),
    ]);
    expect(frame.snapshot.proposals).toEqual([
      expect.objectContaining({ conversationId: a.id, proposalId: proposalA.id }),
    ]);
    expect(frame.snapshot.cases).toEqual([expect.objectContaining({ conversationId: a.id })]);

    await agent.host.updateCase(b.id, { status: "waiting" });
    await agent.host.updateCase(c.id, { status: "waiting" });
    slow.release();
    expect(await nextEvent(client, a.id, "run_ended")).toMatchObject({ outcome: "completed" });
    const serialized = JSON.stringify(client.frames);
    for (const other of ["desk/private", proposalB.id, proposalC.id]) {
      expect(serialized).not.toContain(other);
    }
    for (const id of [b.id, c.id]) {
      expect(serialized).not.toContain(`"conversationId":"${id}"`);
    }
    const events = client.frames
      .filter((f): f is Extract<ActivityFrame, { kind: "event" }> => f.kind === "event")
      .map((f) => f.event);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.conversationId).toBe(a.id);
      expect(event.key).toBe("team/a");
    }
    await client.close();
  });

  it("scopes the stream by tags and follows tag changes", async () => {
    const plugin = definePlugin("ops", () => ({
      tools: [
        deployTool(),
        defineTool({
          name: "lookup",
          description: "Look something up.",
          parameters: Type.Object({}),
          execute: async () => "found",
        }),
      ],
    }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage([fauxToolCall("deploy", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage([fauxToolCall("lookup", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("later done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation({ key: "team/a" });
    const b = await agent.host.createConversation({ key: "team/b" });
    await agent.host.updateCase(a.id, { tags: ["team"] });
    await agent.host.updateCase(b.id, { tags: ["private"] });
    await agent.host.submitInput(a.id, "deploy a", { wait: true });
    await waitForProposal(agent.host, a.id);
    await agent.host.submitInput(b.id, "deploy b", { wait: true });
    await waitForProposal(agent.host, b.id);

    const client = await connectActivity(port, "/activity/ws?tag=team");
    const frame = await client.next();
    if (frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(frame.snapshot.filter).toEqual({ tag: ["team"] });
    expect(frame.snapshot.proposals).toEqual([expect.objectContaining({ conversationId: a.id })]);
    expect(frame.snapshot.cases).toEqual([expect.objectContaining({ conversationId: a.id })]);

    await agent.host.updateCase(b.id, { tags: ["team"] });
    expect(await nextEvent(client, b.id, "case_changed")).toMatchObject({
      conversationId: b.id,
    });
    await agent.host.submitInput(b.id, "lookup now", { wait: true });
    await eventually(() =>
      client.frames.some(
        (f) =>
          f.kind === "event" &&
          f.event.kind === "tool_finished" &&
          f.event.conversationId === b.id &&
          f.event.name === "lookup",
      ),
    );
    expect(await nextEvent(client, b.id, "run_ended")).toMatchObject({ outcome: "completed" });

    const before = client.frames.length;
    await agent.host.updateCase(b.id, { tags: ["private"] });
    await agent.host.submitInput(b.id, "later", { wait: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.frames.length).toBe(before);

    const twoTags = await connectActivity(port, "/activity/ws?tag=team&tag=eu");
    const twoFrame = await twoTags.next();
    if (twoFrame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(twoFrame.snapshot.filter).toEqual({ tag: ["team", "eu"] });
    expect(twoFrame.snapshot.proposals).toEqual([]);
    expect(twoFrame.snapshot.cases).toEqual([]);
    expect(twoFrame.snapshot.runs).toEqual([]);
    await client.close();
    await twoTags.close();
  });

  it("applies comma-separated tags with a key prefix and hides other run and tool ids", async () => {
    const slow = slowTool();
    const plugin = definePlugin("ops", () => ({ tools: [slow.tool] }));
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("a done"),
      fauxAssistantMessage("b done"),
      fauxAssistantMessage("c done"),
    ]);
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const a = await agent.host.createConversation({ key: "team/ops/a" });
    const b = await agent.host.createConversation({ key: "team/ops/b" });
    const c = await agent.host.createConversation({ key: "desk/private" });
    await agent.host.updateCase(a.id, { tags: ["ops", "eu"] });
    await agent.host.updateCase(b.id, { tags: ["ops"] });
    await agent.host.updateCase(c.id, { tags: ["ops", "eu"] });

    const all = await connectActivity(port, "/activity/ws");
    await all.next();
    const runA = await agent.host.submitInput(a.id, "a");
    const runB = await agent.host.submitInput(b.id, "b");
    const runC = await agent.host.submitInput(c.id, "c");
    await eventually(() => slow.started() === 3);
    const toolIds = new Map<string, string>();
    await eventually(() => {
      for (const frame of all.frames) {
        if (
          frame.kind === "event" &&
          frame.event.kind === "tool_started" &&
          (frame.event.conversationId === b.id || frame.event.conversationId === c.id)
        ) {
          toolIds.set(frame.event.conversationId, frame.event.callId);
        }
      }
      return toolIds.has(b.id) && toolIds.has(c.id);
    });
    await all.close();

    const filtered = await connectActivity(port, "/activity/ws?keyPrefix=team%2F&tag=ops,eu");
    const frame = await filtered.next();
    if (frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    expect(frame.snapshot.filter).toEqual({ keyPrefix: "team/", tag: ["ops", "eu"] });
    expect(frame.snapshot.runs).toEqual([
      expect.objectContaining({ conversationId: a.id, runId: runA.submissionId }),
    ]);
    slow.release();
    expect(await nextEvent(filtered, a.id, "run_ended")).toMatchObject({
      runId: runA.submissionId,
      outcome: "completed",
    });
    const serialized = JSON.stringify(filtered.frames);
    for (const hidden of [runB.submissionId, runC.submissionId]) {
      expect(serialized).not.toContain(`"runId":"${hidden}"`);
    }
    for (const hidden of [toolIds.get(b.id)!, toolIds.get(c.id)!]) {
      expect(serialized).not.toContain(`"callId":"${hidden}"`);
    }
    for (const id of [b.id, c.id]) {
      expect(serialized).not.toContain(`"conversationId":"${id}"`);
    }
    const events = filtered.frames
      .filter((f): f is Extract<ActivityFrame, { kind: "event" }> => f.kind === "event")
      .map((f) => f.event);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.conversationId).toBe(a.id);
    await filtered.close();
  });
});
