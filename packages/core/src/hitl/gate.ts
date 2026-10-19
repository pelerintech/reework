import { defineDocFamily, defineTask } from "@earendil-works/pi-durable";
import type { TaskId, TaskOutcome } from "@earendil-works/pi-durable";
import type { Registry } from "@earendil-works/pi-durable";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";
import { defineExtension } from "@earendil-works/pi-durable";
import type { GateDecision, Proposal } from "@reework/types";
import { publishProposal, markProposalSettled } from "../protocol/proposals.ts";

export type { GateDecision };

// ---------------------------------------------------------------------------
// Gate / proposal / decision contracts
// ---------------------------------------------------------------------------

export interface ProposalOption {
  id: string;
  label: string;
}

export interface GateProposal {
  id: string;
  title: string;
  /** Finite offered choices (may be empty for free-form-only gates). */
  options: ProposalOption[];
  acceptFreeForm: boolean;
}

export interface GateOutcome {
  decision: GateDecision;
}

export interface ActionOutcome {
  branch: string;
  decision: GateDecision;
}

// Durable decision store, keyed by proposal id, in the engine's share store.
export const GateDecisionDoc = defineDocFamily<{ decision: GateDecision | null }, string>({
  kind: "rework.gateDecision",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ decision: null }),
});

// In-memory wakeups for gates awaiting a human decision. Writes are durable;
// the wakeup only lets the currently-running gate task proceed.
const pending = new Map<string, (decision: GateDecision) => void>();

function awaitDecision(key: string): Promise<GateDecision> {
  return new Promise<GateDecision>((resolve) => {
    pending.set(key, resolve);
  });
}

/** Deliver a human decision to an open gate (durable + wakes the awaiting task). */
export async function settleGate(engine: Engine, decision: GateDecision): Promise<void> {
  const proposalId = decision.proposalId;
  await engine.commit(async (tx) => {
    (await tx.doc(GateDecisionDoc, proposalId, proposalId)).decision = decision;
  });
  await markProposalSettled(engine, proposalId);
  const wake = pending.get(proposalId);
  if (wake) {
    pending.delete(proposalId);
    wake(decision);
  }
}

/** The durable approval task: presents a proposal and completes on the decision. */
export const GateTask = defineTask<
  { proposal: GateProposal },
  { phase: "awaiting" },
  GateOutcome,
  {}
>({
  name: "rework.gate",
  version: 1,
  initial: () => ({ phase: "awaiting" }),
  phases: {
    awaiting: async (task, runtime, context) => {
      const proposalId = task.input.proposal.id;
      // Prefer a decision already persisted durably (e.g. settled before a restart).
      const existing = (await runtime.snapshot(GateDecisionDoc, proposalId, context))?.decision;
      const decision = existing ?? (await awaitDecision(proposalId));
      await runtime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "completed", result: { decision } },
        }),
        context,
      );
    },
  },
  abort: async () => {},
});

/**
 * The gated action task: does its work, opens a gate (task-join on an approval
 * child), suspends, then branches execution on the human's decision.
 */
export const GatedActionTask = defineTask<
  { proposal: GateProposal },
  { phase: "approve" } | { phase: "decide"; gateId: TaskId<GateOutcome> },
  ActionOutcome,
  {}
>({
  name: "rework.action",
  version: 1,
  initial: () => ({ phase: "approve" }),
  phases: {
    approve: async (task, runtime, context) => {
      const proposal = task.input.proposal;
      await runtime.commit(async (tx, _current) => {
        const gate = await tx.createTask(
          GateTask,
          { proposal },
          { ownership: { kind: "task", taskId: task.id } },
        );
        return {
          status: "waiting",
          checkpoint: { phase: "decide", gateId: gate },
          on: [gate],
          policy: "allSettled",
        };
      }, context);
    },
    decide: async (task, runtime, context) => {
      const [outcome] = await runtime.outcomes([task.state.checkpoint.gateId], context);
      if (outcome.status !== "completed") {
        throw new Error(`gate did not complete: ${outcome.status}`);
      }
      const decision = outcome.result.decision;
      const branch = decision.selectedOption ?? (decision.instruction ? "instruction" : "abort");
      await runtime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "completed", result: { branch, decision } },
        }),
        context,
      );
    },
  },
  abort: async () => {},
});

// ---------------------------------------------------------------------------
// Gated-action tool: a durable action that opens a gate and runs the developer's
// `run` on the decision. Registered alongside the HITL tasks so it can be
// scheduled and resume across restart.
// ---------------------------------------------------------------------------

export interface GatedActionRunContext {
  conversationId: string;
  taskId: string;
  /** Invoke another tool registered on the agent as a nested call. */
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface GatedToolResult {
  branch: string;
  decision: GateDecision;
  output: unknown;
}

/** Developer-supplied `run` functions for registered gated actions, keyed by tool name. */
const gatedRunRegistry = new Map<
  string,
  (ctx: GatedActionRunContext, decision: GateDecision) => Promise<unknown>
>();

export function registerGatedAction(
  name: string,
  run: (ctx: GatedActionRunContext, decision: GateDecision) => Promise<unknown>,
): void {
  gatedRunRegistry.set(name, run);
}

/**
 * The durable gated-action task: opens a gate (a `rework.gate` approval child),
 * suspends as its own durable task, and on the human's decision resumes and runs
 * the registered action's `run`. It is durable, so it survives crash/restart and
 * does not block the rest of the agent.
 */
export const GatedToolTask = defineTask<
  { runKey: string; proposal: GateProposal },
  { phase: "approve" } | { phase: "run"; gateId: TaskId<GateOutcome> },
  GatedToolResult,
  {}
>({
  name: "rework.gatedTool",
  version: 1,
  initial: () => ({ phase: "approve" }),
  phases: {
    approve: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const gate = await tx.createTask(
          GateTask,
          { proposal: task.input.proposal },
          { ownership: { kind: "task", taskId: task.id } },
        );
        return {
          status: "waiting",
          checkpoint: { phase: "run", gateId: gate },
          on: [gate],
          policy: "allSettled",
        };
      }, context);
    },
    run: async (task, runtime, context) => {
      const [outcome] = await runtime.outcomes([task.state.checkpoint.gateId], context);
      if (outcome.status !== "completed") {
        throw new Error(`gate did not complete: ${outcome.status}`);
      }
      const decision = outcome.result.decision;
      const run = gatedRunRegistry.get(task.input.runKey);
      if (!run) {
        throw new Error(`gated action not registered: ${task.input.runKey}`);
      }
      const ctx: GatedActionRunContext = {
        conversationId: String(runtime.conversationId),
        taskId: String(task.id),
        executeTool: async () => {
          throw new Error("executeTool is not available inside a durable gated action");
        },
      };
      const branch = decision.selectedOption ?? (decision.instruction ? "instruction" : "abort");
      const output = await run(ctx, decision);
      await runtime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "completed", result: { branch, decision, output } },
        }),
        context,
      );
    },
  },
  abort: async () => {},
});

/** Independent work that keeps running while a gated action is suspended. */
export const BackgroundTask = defineTask<{}, { phase: "run" }, { note: string }, {}>({
  name: "rework.background",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (_task, runtime, context) => {
      await runtime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "completed", result: { note: "done" } },
        }),
        context,
      );
    },
  },
  abort: async () => {},
});

/** Install the HITL tasks into a registry so a Harness can run them. */
export function installHITL(registry: Registry): void {
  registry.install(
    defineExtension({
      name: "rework.hitl",
      tasks: [GateTask, GatedActionTask, GatedToolTask, BackgroundTask],
    }),
  );
}

async function rootConversation(engine: Engine) {
  return engine.root();
}

/** Create a gated action task on the root conversation and return its task id. */
export async function openGatedAction(
  engine: Engine,
  proposal: GateProposal,
): Promise<TaskId<ActionOutcome>> {
  const root = await rootConversation(engine);
  await publishProposal(engine, {
    id: proposal.id,
    conversationId: String(root.id),
    title: proposal.title,
    options: proposal.options,
    acceptFreeForm: proposal.acceptFreeForm,
    createdAt: Date.now(),
  } as Proposal);
  return engine.commit((tx) =>
    tx.createTask(
      GatedActionTask,
      { proposal },
      {
        conversationId: root.id,
        ownership: { kind: "conversation" },
      },
    ),
  );
}

/** Create a background task on the root conversation and return its id. */
export async function openBackgroundTask(engine: Engine): Promise<TaskId<{ note: string }>> {
  const root = await rootConversation(engine);
  return engine.commit((tx) =>
    tx.createTask(
      BackgroundTask,
      {},
      {
        conversationId: root.id,
        ownership: { kind: "conversation" },
      },
    ),
  );
}

/** Wait for a task to settle and return its outcome. */
export async function waitForOutcome<T>(engine: Engine, id: TaskId<T>): Promise<TaskOutcome<T>> {
  const settled = await engine.harness.waitForTask(id, CONTEXT);
  return settled.state.outcome;
}
