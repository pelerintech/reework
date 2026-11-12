// `@reework/core/testing` — what an agent project needs to test itself: a scripted
// model at the LLM boundary, a disposable agent, and waits for the protocol's states.
// It imports no test runner, so it works under vitest and `node --test` alike.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models, MutableModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { FileRecord, Proposal } from "@reework/types";
import type { AgentDefinition, AgentModel } from "./agent-definition.ts";
import type { AgentHost } from "./host.ts";
import { CONTEXT } from "./engine.ts";
import type { Engine } from "./engine.ts";
import { ConversationsDoc } from "./protocol/conversations.ts";
import type { ConversationRecord } from "./protocol/conversations.ts";
import { MODEL_PROVIDER_ID, startAgent } from "./runtime/bootstrap.ts";
import type { RunningAgent, StartAgentOptions } from "./runtime/bootstrap.ts";

type ToolArgs = Parameters<typeof fauxToolCall>[1];

/** One scripted model reply: a message, or a function of the request returning one. */
export type ScriptedStep = FauxResponseStep;

/** A scripted assistant message, as `text` / `toolCall` build it. */
export type ScriptedMessage = ReturnType<typeof fauxAssistantMessage>;

/** How a scripted answer is streamed: speed and chunk size in tokens. */
export interface ScriptedStreaming {
  readonly tokensPerSecond?: number;
  readonly tokenSize?: { readonly min?: number; readonly max?: number };
}

export interface ScriptedModel {
  /** Pass as `StartAgentOptions.models`. */
  readonly models: Models;
  /** Replace the queued replies. */
  respond(steps: ScriptedStep[]): void;
  /** Queue more replies after the current ones. */
  append(steps: ScriptedStep[]): void;
  /** One scripted model per declared named model, keyed by name. */
  readonly named: Record<
    string,
    { respond(steps: ScriptedStep[]): void; append(steps: ScriptedStep[]): void }
  >;
}

/** A model that answers from a script, registered where the agent's model is looked up. */
export function scriptedModel(modelId: string, streaming: ScriptedStreaming = {}): ScriptedModel {
  const faux = fauxProvider({
    ...streaming,
    provider: MODEL_PROVIDER_ID,
    models: [{ id: modelId }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    respond: (steps) => faux.setResponses(steps),
    append: (steps) => faux.appendResponses(steps),
    named: {},
  };
}

/** Register one scripted model per declared named model into a catalog built by `scriptedModel`. */
function registerNamedModels(model: ScriptedModel, named: Record<string, AgentModel>): void {
  for (const [name, def] of Object.entries(named)) {
    const nf = fauxProvider({
      provider: `reework.model.${name}`,
      models: [{ id: def.modelId }],
    });
    (model.models as MutableModels).setProvider(nf.provider);
    model.named[name] = {
      respond: (steps) => nf.setResponses(steps),
      append: (steps) => nf.appendResponses(steps),
    };
  }
}

/**
 * A mock catalog under the faux provider's own id (`faux` / `faux-1`), for code that
 * opens an `Engine` directly. Agents started with `startAgent` use `scriptedModel`.
 */
export function createMockModels(): {
  models: Models;
  setResponses: (steps: ScriptedStep[]) => void;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, setResponses: (steps) => faux.setResponses(steps) };
}

/** A plain text answer. */
export function text(answer: string): ScriptedMessage {
  return fauxAssistantMessage(answer);
}

/** A reply that calls one tool. */
export function toolCall(name: string, args: Record<string, unknown> = {}): ScriptedMessage {
  return toolCalls([[name, args]]);
}

/** A reply that calls several tools in one round. */
export function toolCalls(
  calls: [name: string, args?: Record<string, unknown>][],
): ScriptedMessage {
  return fauxAssistantMessage(
    calls.map(([name, args]) => fauxToolCall(name, (args ?? {}) as ToolArgs)),
    { stopReason: "toolUse" },
  );
}

export interface TestAgent {
  readonly agent: RunningAgent;
  /** The scripted model the agent uses (unless `models` was passed). */
  readonly model: ScriptedModel;
  /** One scripted model per declared named model, keyed by name (same as `model.named`). */
  readonly models: ScriptedModel["named"];
  /** The API token the agent was started with. */
  readonly token: string;
  /** Stop the agent and remove its temporary storage. */
  readonly dispose: () => Promise<void>;
}

/**
 * Start `definition` on temporary storage with a generated API token (passed by
 * value — the environment is not touched) and a scripted model unless `models` is given.
 */
export async function startTestAgent(
  definition: AgentDefinition,
  options: Partial<StartAgentOptions> = {},
): Promise<TestAgent> {
  const model = scriptedModel(definition.model?.modelId ?? "m1");
  registerNamedModels(model, definition.models ?? {});
  const token = randomBytes(16).toString("hex");
  const storagePath =
    options.storagePath ?? join(mkdtempSync(join(tmpdir(), "reework-test-")), "agent.sqlite");
  const agent = await startAgent(definition, {
    ...options,
    storagePath,
    models: options.models ?? model.models,
    auth: { ...options.auth, token: options.auth?.token ?? token },
  });
  let disposed = false;
  return {
    agent,
    model,
    models: model.named,
    token: options.auth?.token ?? token,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await agent.stop();
      if (!options.storagePath) rmSync(dirname(storagePath), { recursive: true, force: true });
    },
  };
}

/** A plugin WebSocket opened against a running agent. */
export interface PluginWebSocketClient {
  readonly socket: WebSocket;
  /** The ephemeral port the helper listened on. */
  readonly port: number;
  /** Close the socket and the listener this helper opened. */
  close(): Promise<void>;
}

/**
 * Open a plugin WebSocket against a real listener: the helper listens on an
 * ephemeral port, sends the test agent's token when it has one, and resolves
 * once the handshake completed.
 */
export async function openPluginWebSocket(
  target: TestAgent | RunningAgent,
  path: string,
  options: {
    readonly token?: string;
    readonly headers?: Record<string, string>;
    readonly timeoutMs?: number;
  } = {},
): Promise<PluginWebSocketClient> {
  const test = "dispose" in target ? (target as TestAgent) : undefined;
  const running = test ? test.agent : (target as RunningAgent);
  const token = options.token ?? test?.token;
  const { port, close: closeServer } = await running.listen(0);
  const headers: Record<string, string> = { ...options.headers };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers,
    handshakeTimeout: options.timeoutMs ?? 5000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
  } catch (error) {
    // A refused or timed-out handshake leaves no client to close the listener.
    socket.on("error", () => {});
    try {
      socket.close();
    } catch {}
    // Closing stops new connections at once; awaiting would hang while a
    // pending upgrade's factory never settles.
    void closeServer().catch(() => {});
    throw error;
  }
  let closed = false;
  return {
    socket,
    port,
    async close() {
      if (closed) return;
      closed = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close();
        });
      }
      await closeServer();
    },
  };
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/** Poll `check` until it returns a truthy value; reject after the timeout. */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 5000, intervalMs = 20 }: WaitOptions = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The tools offered to the model for a conversation: names and parameter schemas.
 *  Accepts a `TestAgent` or its `RunningAgent`; honors `mission.tools` narrowing. */
export function offeredTools(
  target: RunningAgent | TestAgent,
  _conversationId: string,
): { name: string; parameters: unknown }[] {
  const running = "host" in target ? (target as RunningAgent) : (target as TestAgent).agent;
  const missionTools = running.agent.mission.tools;
  const tools = running.host.engine.registry
    .snapshot()
    .tools()
    .filter(({ tool }) => tool.callers === undefined || tool.callers.includes("model"))
    .map(({ tool }) => ({ name: tool.name, parameters: tool.parameters }));
  return missionTools ? tools.filter((t) => missionTools.includes(t.name)) : tools;
}

let legacySeed = 0;

/**
 * Write a conversation record shaped as it was before `kind` existed (test-only).
 * The record carries no `kind`, so the read path must default it to `"case"`.
 * Returns the seeded case id.
 */
export async function seedLegacyCase(
  target: TestAgent | RunningAgent,
  options: { readonly key?: string } = {},
): Promise<string> {
  const running = "dispose" in target ? (target as TestAgent).agent : (target as RunningAgent);
  const engine = (running as unknown as { engine: Engine }).engine;
  const id = String(Date.now() + legacySeed++);
  await engine.commit(async (tx) => {
    const doc = (await tx.doc(ConversationsDoc)) as { conversations: ConversationRecord[] };
    doc.conversations.push({
      id,
      ...(options.key === undefined ? {} : { key: options.key }),
      createdAt: Date.now(),
    });
  });
  return id;
}

/** Upload bytes to a conversation through the host; returns the stored record. */
export function addFile(
  test: TestAgent,
  conversationId: string,
  input: { name: string; mimeType?: string; bytes: Uint8Array },
): Promise<FileRecord> {
  return test.agent.host.addFile(conversationId, input);
}

/** Wait until the conversation has an open proposal and return the oldest. */
export async function waitForProposal(
  host: AgentHost,
  conversationId: string,
  options?: WaitOptions,
): Promise<Proposal> {
  return waitFor(async () => (await host.listProposals({ conversationId }))[0], options);
}

/**
 * Wait until the conversation is idle: no input queued or answering, and no work
 * running in the agent other than gates waiting on a human. Idle must hold for a few
 * polls in a row, so work that is about to start (a gate's resume) is not missed.
 */
export async function waitForIdle(
  host: AgentHost,
  conversationId: string,
  options?: WaitOptions,
): Promise<void> {
  let calm = 0;
  await waitFor(async () => {
    calm = (await isIdle(host, conversationId)) ? calm + 1 : 0;
    return calm >= 3;
  }, options);
}

/** Tasks that wait for a human decision while their proposal is open. */
const WAITS_ON_HUMAN = new Set(["rework.gate", "rework.gatedTool"]);

async function isIdle(host: AgentHost, conversationId: string): Promise<boolean> {
  const inspection = await host.engine.harness.inspect(CONTEXT);
  if (inspection.submissions.some((s) => String(s.conversationId) === conversationId)) return false;
  const waitingOnHuman = (await host.listProposals({ conversationId })).length > 0;
  return inspection.tasks.every((task) => {
    const record = task.record as { kind?: string; conversationId?: number };
    if (record.conversationId !== undefined && String(record.conversationId) !== conversationId) {
      return true;
    }
    if (task.state.kind === "waiting") return true;
    return waitingOnHuman && WAITS_ON_HUMAN.has(record.kind ?? "");
  });
}
