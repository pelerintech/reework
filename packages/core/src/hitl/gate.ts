import { defineDocFamily, defineExtension, defineTask } from "@earendil-works/pi-durable";
import type {
  Registry,
  RegistryReader,
  TaskId,
  TaskOutcome,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { GateDecision, Proposal } from "@reework/types";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";
import { markProposalSettled, publishProposal } from "../protocol/proposals.ts";
import type { StorageSeam } from "../tooling/storage.ts";

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

export interface GatedActionRunContext {
  conversationId: string;
  taskId: string;
  /** The engine's durable storage seam. */
  storage: StorageSeam;
}

export interface GatedToolResult {
  branch: string;
  decision: GateDecision;
  output: unknown;
}

type GatedRun = (
  ctx: GatedActionRunContext,
  decision: GateDecision,
  args: JsonValue,
) => Promise<unknown>;

// Durable decision store, keyed by proposal id, in the engine's share store.
export const GateDecisionDoc = defineDocFamily<{ decision: GateDecision | null }, string>({
  kind: "rework.gateDecision",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ decision: null }),
});

// ---------------------------------------------------------------------------
// Per-engine gate state
// ---------------------------------------------------------------------------

/**
 * Everything the gate machinery keeps in memory, owned by one registry (and so
 * one engine). Two agents in one process never share it.
 */
export interface HitlState {
  /** Wakeups for gates awaiting a decision; the decision itself is durable. */
  readonly pending: Map<string, (decision: GateDecision) => void>;
  /** In-process listeners for newly opened proposals. */
  readonly listeners: Set<(proposal: Proposal) => void>;
  /** In-process listeners for proposals settled by a decision. */
  readonly settledListeners: Set<(settled: SettledProposal) => void>;
  /** The developer `run` of each gated action, by tool name. */
  readonly runs: Map<string, GatedRun>;
  /** The owning engine's storage seam, set when the engine opens. */
  storage?: StorageSeam;
}

/** A proposal settled by a human decision. */
export interface SettledProposal {
  readonly proposalId: string;
  readonly conversationId: string;
  readonly decision: GateDecision;
}

const states = new WeakMap<object, HitlState>();

/** The gate state owned by `registry`, created on first use. */
export function hitlState(registry: RegistryReader): HitlState {
  let state = states.get(registry);
  if (!state) {
    state = {
      pending: new Map(),
      listeners: new Set(),
      settledListeners: new Set(),
      runs: new Map(),
    };
    states.set(registry, state);
  }
  return state;
}

/** Marks a tool registration as a gated action carrying its `run`. */
const GATED = Symbol.for("reework.gatedAction");

export function markGated<T extends ToolRegistration>(tool: T, run: GatedRun): T {
  return Object.assign(tool, { [GATED]: run });
}

/** Register every gated action's `run` found among the registry's tools. */
export function collectGatedRuns(registry: RegistryReader): void {
  const state = hitlState(registry);
  for (const { tool } of registry.snapshot().tools()) {
    const run = (tool as { [GATED]?: GatedRun })[GATED];
    if (run) state.runs.set(tool.name, run);
  }
}

export function notifyProposalOpen(state: HitlState, proposal: Proposal): void {
  for (const listener of state.listeners) listener(proposal);
}

/** Deliver a human decision to an open gate (durable + wakes the awaiting task). */
export async function settleGate(engine: Engine, decision: GateDecision): Promise<void> {
  const proposalId = decision.proposalId;
  await engine.commit(async (tx) => {
    (await tx.doc(GateDecisionDoc, proposalId, proposalId)).decision = decision;
  });
  const conversationId = await markProposalSettled(engine, proposalId);
  if (conversationId !== undefined) {
    for (const listener of engine.hitl.settledListeners) {
      listener({ proposalId, conversationId, decision });
    }
  }
  const wake = engine.hitl.pending.get(proposalId);
  if (wake) {
    engine.hitl.pending.delete(proposalId);
    wake(decision);
  }
}

// ---------------------------------------------------------------------------
// Durable tasks, built per state
// ---------------------------------------------------------------------------

function createHitlTasks(state: HitlState) {
  const awaitDecision = (key: string, signal: AbortSignal | undefined) =>
    new Promise<GateDecision>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const onAbort = () => {
        state.pending.delete(key);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      state.pending.set(key, (decision) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      });
    });

  /** The durable approval task: presents a proposal and completes on the decision. */
  const GateTask = defineTask<{ proposal: GateProposal }, { phase: "awaiting" }, GateOutcome, {}>({
    name: "rework.gate",
    version: 1,
    initial: () => ({ phase: "awaiting" }),
    phases: {
      awaiting: async (task, runtime, context) => {
        const proposalId = task.input.proposal.id;
        // Prefer a decision already persisted durably (e.g. settled before a restart).
        const existing = (await runtime.snapshot(GateDecisionDoc, proposalId, context))?.decision;
        const decision = existing ?? (await awaitDecision(proposalId, context.abortSignal));
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
   * The gated action task: opens a gate (task-join on an approval child),
   * suspends, then branches execution on the human's decision.
   */
  const GatedActionTask = defineTask<
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
        await runtime.commit(async (tx) => {
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

  /**
   * The durable gated-action tool task: opens a gate (a `rework.gate` approval
   * child), suspends as its own durable task, and on the human's decision runs
   * the gated action's `run`. It survives restart and does not block the agent.
   */
  const GatedToolTask = defineTask<
    { runKey: string; args: JsonValue; proposal: GateProposal; createdAt: number },
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
        const { proposal, createdAt } = task.input;
        notifyProposalOpen(state, {
          ...proposal,
          conversationId: String(runtime.conversationId),
          createdAt,
        });
      },
      run: async (task, runtime, context) => {
        const [outcome] = await runtime.outcomes([task.state.checkpoint.gateId], context);
        if (outcome.status !== "completed") {
          throw new Error(`gate did not complete: ${outcome.status}`);
        }
        const decision = outcome.result.decision;
        const run = state.runs.get(task.input.runKey);
        if (!run) {
          throw new Error(`gated action not registered: ${task.input.runKey}`);
        }
        if (!state.storage) throw new Error("gate state has no engine");
        const ctx: GatedActionRunContext = {
          conversationId: String(runtime.conversationId),
          taskId: String(task.id),
          storage: state.storage,
        };
        const branch = decision.selectedOption ?? (decision.instruction ? "instruction" : "abort");
        let result: { output: unknown } | { error: string };
        try {
          result = { output: await run(ctx, decision, task.input.args ?? null) };
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        // Resume the agent: the outcome becomes its next input, so it can verify,
        // follow up, or act on a free-form instruction. Keyed so a rerun posts once.
        const conversation = await runtime.conversation(runtime.conversationId, context);
        await conversation?.submit(
          {
            type: "input",
            content: describeOutcome(task.input.runKey, decision, result),
            requestId: `reework.gated:${String(task.id)}`,
          },
          context,
        );
        await runtime.commit(
          async () =>
            "error" in result
              ? {
                  status: "terminal",
                  outcome: { status: "failed", error: { message: result.error } },
                }
              : {
                  status: "terminal",
                  outcome: {
                    status: "completed",
                    result: { branch, decision, output: result.output },
                  },
                },
          context,
        );
      },
    },
    abort: async () => {},
  });

  /** Independent work that keeps running while a gated action is suspended. */
  const BackgroundTask = defineTask<{}, { phase: "run" }, { note: string }, {}>({
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

  return { GateTask, GatedActionTask, GatedToolTask, BackgroundTask };
}

/** The input that tells the agent how a gated action ended. */
function describeOutcome(
  name: string,
  decision: GateDecision,
  result: { output: unknown } | { error: string },
): string {
  const choice = [
    decision.selectedOption ? `option "${decision.selectedOption}"` : undefined,
    decision.instruction ? `instruction: ${decision.instruction}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const outcome =
    "error" in result
      ? `failed: ${result.error}`
      : `result: ${JSON.stringify(result.output ?? null)}`;
  return `[gated action ${name}] The human decided (${choice || "no choice"}). ${outcome}`;
}

/** Task tokens used to create HITL tasks; the registry runs its own per-state copies. */
const tokens = createHitlTasks({
  pending: new Map(),
  listeners: new Set(),
  settledListeners: new Set(),
  runs: new Map(),
});
export const GateTask = tokens.GateTask;
export const GatedActionTask = tokens.GatedActionTask;
export const GatedToolTask = tokens.GatedToolTask;
export const BackgroundTask = tokens.BackgroundTask;

/** Install the HITL tasks into a registry so a Harness can run them. */
export function installHITL(registry: Registry): HitlState {
  const state = hitlState(registry);
  if (!registry.snapshot().extension("rework.hitl")) {
    const tasks = createHitlTasks(state);
    registry.install(
      defineExtension({
        name: "rework.hitl",
        tasks: [tasks.GateTask, tasks.GatedActionTask, tasks.GatedToolTask, tasks.BackgroundTask],
      }),
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// Low-level (Pattern 2) helpers: task-level gating on the root conversation
// ---------------------------------------------------------------------------

/** Create a gated action task on the root conversation and return its task id. */
export async function openGatedAction(
  engine: Engine,
  proposal: GateProposal,
): Promise<TaskId<ActionOutcome>> {
  const root = await engine.root();
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
  const root = await engine.root();
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
