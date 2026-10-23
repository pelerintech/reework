// `@reework/core/testing` — what an agent project needs to test itself: a scripted
// model at the LLM boundary, a disposable agent, and waits for the protocol's states.
// It imports no test runner, so it works under vitest and `node --test` alike.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Proposal } from "@reework/types";
import type { AgentDefinition } from "./agent-definition.ts";
import type { AgentHost } from "./host.ts";
import { CONTEXT } from "./engine.ts";
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
  };
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
  const model = scriptedModel(definition.model.modelId);
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
    token: options.auth?.token ?? token,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await agent.stop();
      if (!options.storagePath) rmSync(dirname(storagePath), { recursive: true, force: true });
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
