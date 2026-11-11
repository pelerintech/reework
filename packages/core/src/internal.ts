// `@reework/core/internal` — the framework's own internals. No stability promise;
// for the framework's own tests and emergencies only. Everything here is hidden
// from the main entry so the facade stays the only path to pi-durable.
export { Engine, CONTEXT } from "./engine.ts";
export type { EngineOptions } from "./engine.ts";

export { StorageSeam } from "./tooling/storage.ts";
export type { StorageSeam as StorageSeamType } from "./tooling/storage.ts";

export { once, onceInCommit } from "./tooling/once.ts";

export { toDurableTool, toolInternal, toExtension } from "./tooling/facade.ts";
export type { ToolContext, ToolInternal } from "./tooling/facade.ts";

export { createComponentRegistry, installComponents } from "./tooling/component.ts";
export type { Component, ComponentRegistry, DomainComponent } from "./tooling/component.ts";

export {
  BackgroundTask,
  GateDecisionDoc,
  GateTask,
  GatedActionTask,
  GatedToolTask,
  installHITL,
  openBackgroundTask,
  openGatedAction,
  settleGate,
  waitForOutcome,
} from "./hitl/gate.ts";

export { createEventMapper, mapDurableEvent } from "./protocol/event-mapper.ts";
export type { EventMapperState } from "./protocol/event-mapper.ts";

export { createRegistry } from "./runtime/bootstrap.ts";
export { ConversationsDoc } from "./protocol/conversations.ts";
export { ProposalsDoc } from "./protocol/proposals.ts";
export type { RunningAgent } from "./runtime/bootstrap.ts";
import type { RunningAgent as RA } from "./runtime/bootstrap.ts";
import type { Engine } from "./engine.ts";
/** The engine a running agent holds, for the framework's own tests and tools. */
export function engineOf(agent: RA): Engine {
  return (agent as unknown as { engine: Engine }).engine;
}

/** The low-level (Pattern 2) HITL helpers, for the framework's own use. */
export { collectGatedRuns, hitlState, markGated, notifyProposalOpen } from "./hitl/gate.ts";
export type { HitlState, SettledProposal } from "./hitl/gate.ts";
