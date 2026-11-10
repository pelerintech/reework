export const REEWORK_VERSION = "0.0.0";

export { defineAgent } from "./agent-definition.ts";
export type {
  AgentDefinition,
  AgentModel,
  AgentModelProvider,
  AgentModelApi,
  AgentMission,
  DeclaredModule,
  RunLimits,
  SecretDefinition,
  SecretsBackend,
} from "./agent-definition.ts";

export {
  AgentHost,
  ConversationNotFound,
  HeadlessAgentError,
  InvalidAuthor,
  InvalidProposalStatus,
  ProposalNotFound,
} from "./host.ts";
export type { ConversationRecord } from "./protocol/conversations.ts";
export type {
  ConversationInfo,
  ConversationRead,
  ConversationSnapshot,
  CreateConversationOptions,
  ListCasesFilter,
  SubmitOptions,
  SubmitResult,
} from "./host.ts";

export {
  CodingTools,
  codingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  createPluginContextMembers,
  definePlugin,
  defineTool,
  gatedRunOf,
  isReeworkPlugin,
  isReeworkTool,
  markGatedTool,
  ModelCallRefused,
  section,
  Type,
} from "./tooling/index.ts";
export type {
  BuiltPlugin,
  RouteApp,
  PluginRouteContext,
  PluginSetupContext,
  PluginHooks,
  PluginHookContext,
  PluginEventContext,
  ModelUsageEvent,
  ModelCallRequest,
  SecretUseEvent,
  PluginStore,
  PluginStoreScope,
  PluginStoreItem,
  PluginModels,
  PluginSecrets,
  CaseFiles,
  CaseContext,
  PluginCases,
  PluginDecision,
  ReeworkPlugin,
  ReeworkTool,
  ToolContext,
  ToolResult,
  Static,
  TSchema,
  WorkspaceProvider,
  WorkspaceTarget,
} from "./tooling/index.ts";

export type { Author, AuthorKind, ModelCallUsage, ModelUsage, RunStopNotice } from "@reework/types";
export { isAuthor, normalizeAuthor, PLUGIN_ROUTE_PREFIX } from "@reework/types";

export { createServer } from "./server/index.ts";

export { MODEL_PROVIDER_ID, startAgent } from "./runtime/bootstrap.ts";
export type { RunningAgent, StartAgentOptions } from "./runtime/bootstrap.ts";

export { gatedAction } from "./hitl/gated-action-tool.ts";

export { listOpenProposals, onProposalOpen, onProposalSettled } from "./protocol/proposals.ts";
export type { OpenProposal } from "./protocol/proposals.ts";

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
} from "./hitl/gate.ts";
