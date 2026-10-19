export const REEWORK_VERSION = "0.0.0";

export { defineAgent } from "./agent-definition.ts";
export type {
  AgentDefinition,
  AgentModel,
  AgentModelProvider,
  AgentMission,
  DeclaredModule,
} from "./agent-definition.ts";

export { Engine, createMockModels, CONTEXT } from "./engine.ts";
export type { EngineOptions } from "./engine.ts";

export {
  StorageSeam,
  createComponentRegistry,
  installComponents,
  definePlugin,
  defineTool,
  installPlugin,
  section,
} from "./tooling/index.ts";
export type {
  StorageSeamType,
  Component,
  ComponentRegistry,
  DomainComponent,
  PluginDefinition,
} from "./tooling/index.ts";

export { WebChannel, WhatsAppChannel } from "./channels/index.ts";

export { createServer } from "./server/index.ts";

export { startAgent } from "./runtime/bootstrap.ts";
export type { RunningAgent, StartAgentOptions } from "./runtime/bootstrap.ts";

export {
  GateDecisionDoc,
  GateTask,
  GatedActionTask,
  BackgroundTask,
  installHITL,
  openGatedAction,
  openBackgroundTask,
  settleGate,
  waitForOutcome,
} from "./hitl/gate.ts";

export { gatedAction } from "./hitl/gated-action-tool.ts";

export { listOpenProposals, onProposalOpen } from "./protocol/proposals.ts";
export type { OpenProposal } from "./protocol/proposals.ts";

export { mapDurableEvent } from "./protocol/event-mapper.ts";
export type {
  GatedActionDefinition,
  GatedActionGate,
  GatedActionRunContext,
} from "./hitl/gated-action-tool.ts";
export type {
  GateProposal,
  GateDecision,
  GateOutcome,
  ActionOutcome,
  ProposalOption,
} from "./hitl/gate.ts";
