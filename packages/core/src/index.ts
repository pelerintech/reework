export const REEWORK_VERSION = "0.0.0";

export { defineAgent } from "./agent-definition.ts";
export type {
  AgentDefinition,
  AgentModel,
  AgentModelProvider,
  AgentModelApi,
  AgentMission,
  DeclaredModule,
} from "./agent-definition.ts";

export { AgentHost, ConversationNotFound, ProposalNotFound } from "./host.ts";
export type { ConversationRecord } from "./protocol/conversations.ts";
export type {
  ConversationInfo,
  ConversationRead,
  ConversationSnapshot,
  CreateConversationOptions,
  SubmitOptions,
  SubmitResult,
} from "./host.ts";

export { Engine, createMockModels, CONTEXT } from "./engine.ts";
export type { EngineOptions } from "./engine.ts";

export {
  CodingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  StorageSeam,
  createComponentRegistry,
  installComponents,
  definePlugin,
  defineTool,
  isReeworkPlugin,
  once,
  onceInCommit,
  toExtension,
  section,
  Type,
} from "./tooling/index.ts";
export type {
  StorageSeamType,
  Component,
  ComponentRegistry,
  DomainComponent,
  BuiltPlugin,
  PluginSetupContext,
  ReeworkPlugin,
  Static,
  TSchema,
  WorkspaceProvider,
  WorkspaceTarget,
} from "./tooling/index.ts";

export { createServer } from "./server/index.ts";

export { MODEL_PROVIDER_ID, startAgent } from "./runtime/bootstrap.ts";
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
  GatedActionGateContext,
  GatedActionRunContext,
} from "./hitl/gated-action-tool.ts";
export type {
  GateProposal,
  GateDecision,
  GateOutcome,
  ActionOutcome,
  ProposalOption,
  HitlState,
} from "./hitl/gate.ts";
