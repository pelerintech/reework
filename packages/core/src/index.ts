export const REEWORK_VERSION = "0.0.0";

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
export type {
  GateProposal,
  GateDecision,
  GateOutcome,
  ActionOutcome,
  ProposalOption,
} from "./hitl/gate.ts";
