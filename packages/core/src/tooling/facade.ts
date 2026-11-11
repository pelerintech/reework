import {
  CompactionTask,
  defineExtension,
  defineTool as durableDefineTool,
  GenerationTask,
  hook,
  LiveDoc,
  section as durableSection,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  Extension,
  EntryRecord,
  ConversationId,
  HookApi,
  HookRegistration,
  PromptInput,
  PromptSection,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Hono } from "hono";
import type { Context, JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type {
  Author,
  Case,
  Proposal,
  CasePatch,
  FileRecord,
  GateDecision,
  ModelCallUsage,
  ModelMessage,
  ModelUsage,
  RunStopNotice,
} from "@reework/types";
import { isAuthor } from "@reework/types";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { AgentHost, ConversationSnapshot, ListCasesFilter } from "../host.ts";
import { endRun } from "../runtime/abort.ts";
import type { RequestLimiter } from "../runtime/models.ts";
import type { SecretsAccess } from "../runtime/secrets.ts";
import { markGated } from "../hitl/gate.ts";
import type { GatedActionRunContext } from "../hitl/gate.ts";
import { once } from "./once.ts";
import { createPluginStore } from "./plugin-store.ts";
import type { StoreBackend } from "./plugin-store.ts";

/**
 * The plugin facade. This is the single point that touches pi-durable's
 * extension API. Plugins import only `@reework/core`, so a pi-durable API change
 * is contained here and the plugins keep working without modification.
 *
 * The v06 contract is reework's own: tools, sections, hooks, storage and models
 * are reework shapes (an opaque `ReeworkTool`, a reework `ToolContext`), and the
 * pi-durable plumbing (registrations, `StorageSeam`, internals) is confined here.
 */

/** A plugin's route app; plugins never import hono themselves. */
export type { Hono as RouteApp };

/** The schema builder for tool parameters, so plugins need not import pi-ai. */
export { Type };
export type { Static, TSchema };

/**
 * pi-durable's coding tools (read, write, edit, bash), unchanged. They act in the
 * conversation's workspace `cwd`; relative paths resolve there, but nothing
 * confines absolute or `../` paths — wrap them if you need a hard boundary.
 */
import {
  CodingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

export {
  CodingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
};

/**
 * pi-durable's coding tools (read, write, edit, bash) as reework tools. They
 * act in the conversation's workspace `cwd`; relative paths resolve there, but
 * nothing confines absolute or `../` paths — wrap them if you need a hard
 * boundary.
 */
export function codingTools(): ReeworkTool[] {
  return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()].map(
    wrapCodingTool,
  );
}

function wrapCodingTool(tool: ToolRegistration): ReeworkTool {
  return {
    __reworkTool: true,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.replay === undefined ? {} : { replay: tool.replay }),
    async execute(args, ctx) {
      const { api, context } = toolInternal(ctx);
      const result = await tool.execute(args, api, context);
      return durableOutputText(result);
    },
  };
}

/** The model-facing text of a pi-durable tool execution result. */
function durableOutputText(result: ToolExecutionResult): string {
  const content = result.output;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  return result.isError ? "error" : "";
}

/** The conversation a workspace is prepared for. */
export interface WorkspaceTarget {
  readonly conversationId: string;
  readonly key?: string;
}

/** Prepares a working directory for each new conversation (a clone, a worktree, a temp dir). */
export interface WorkspaceProvider {
  create(conversation: WorkspaceTarget): Promise<{ cwd: string }>;
}

// ---------------------------------------------------------------------------
// Models (§3): a plugin calls a named model by name.
// ---------------------------------------------------------------------------

export interface ModelInputTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ModelInputImageBlock {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type ModelInputMessageBlock = ModelInputTextBlock | ModelInputImageBlock;

/** A message passed to a named model's `complete` (a text/image slice of the wire). */
export interface ModelInputMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly ModelInputMessageBlock[];
}

export interface ModelCompleteInput {
  readonly system?: string;
  readonly messages: string | readonly ModelInputMessage[];
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ModelCompleteResult {
  readonly text: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface ModelEmbedOptions {
  /** Aborts this call; combined with the context's own signal where one exists. */
  readonly signal?: AbortSignal;
}

export interface ModelEmbedResult {
  readonly embeddings: number[][];
  readonly usage?: ModelUsage;
}

/** The named models a plugin declared, keyed by name. */
export interface PluginModels {
  complete(name: string, input: ModelCompleteInput): Promise<ModelCompleteResult>;
  embed(
    name: string,
    texts: readonly string[],
    options?: ModelEmbedOptions,
  ): Promise<ModelEmbedResult>;
}

// ---------------------------------------------------------------------------
// Secrets: requests made with a declared secret applied, and audited raw reads.
// ---------------------------------------------------------------------------

/** The secrets a plugin may use: fetch applies a secret, get returns its value. */
export interface PluginSecrets {
  /** Send `url` with the named secret applied; the value is never returned. */
  fetch(name: string, url: string, init?: RequestInit): Promise<Response>;
  /** The raw value of a named secret; declared and audited. */
  get(name: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Files (§5): scoped to the calling conversation.
// ---------------------------------------------------------------------------

export interface CaseFiles {
  list(): Promise<FileRecord[]>;
  read(id: string): Promise<{ record: FileRecord; bytes: Uint8Array }>;
  add(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<FileRecord>;
}

// ---------------------------------------------------------------------------
// Case (§4): the conversation as the human sees it.
// ---------------------------------------------------------------------------

export interface CaseContext {
  get(): Promise<Case>;
  update(patch: CasePatch): Promise<Case>;
}

// ---------------------------------------------------------------------------
// Cases capability (§4): reach other cases as a given principal, agent-scoped.
// ---------------------------------------------------------------------------

/** The choice a `ctx.cases.decide` settles a proposal with. */
export interface PluginDecision {
  readonly selectedOption: string | null;
  readonly instruction: string | null;
}

/**
 * Other cases of this agent, granted by declaring `{ cases: true }`. A desk
 * tool or event hook lists, reads, snapshots, submits input to and decides on
 * cases as a given principal. The declaration is the grant and the audit point.
 */
export interface PluginCases {
  list(filter?: ListCasesFilter): Promise<Case[]>;
  get(id: string): Promise<Case>;
  snapshot(id: string): Promise<ConversationSnapshot>;
  submit(
    id: string,
    text: string,
    options?: { readonly from?: Author },
  ): Promise<{ readonly submissionId: string }>;
  decide(input: {
    readonly proposalId: string;
    readonly decision: PluginDecision;
    readonly decidedBy?: Author;
  }): Promise<void>;
  update(id: string, patch: CasePatch): Promise<Case>;
}

// ---------------------------------------------------------------------------
// Plugin storage (§1 / task 6): the plugin's own store, agent-wide and per case.
// ---------------------------------------------------------------------------

export interface PluginStoreItem {
  readonly key: string;
  readonly value: JsonValue;
}

export interface PluginStoreScope {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  update(key: string, change: (value: JsonValue | undefined) => JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<PluginStoreItem[]>;
}

export interface PluginStore {
  readonly agent: PluginStoreScope;
  readonly case: PluginStoreScope;
}

// ---------------------------------------------------------------------------
// The reework tool contract.
// ---------------------------------------------------------------------------

/** What a tool's `execute` returns: text for the model, and whether it failed. */
export interface ToolResult {
  readonly output: string;
  readonly isError?: boolean;
  readonly details?: JsonValue;
  /** This result is outside content, even when the tool itself is not flagged. */
  readonly external?: boolean;
}

/** The reework context a tool receives. */
export interface ToolContext {
  /** The case (conversation) the tool runs in, as a string id. */
  readonly conversationId: string;
  /** Aborted when the run is stopped or the agent shuts down. */
  readonly signal: AbortSignal;
  /** Append running output; it becomes the result's output when it is omitted. */
  output(chunk: string): void;
  /** The named models this plugin declared. */
  readonly models: PluginModels;
  /** Requests with a declared secret applied. */
  readonly secrets: PluginSecrets;
  /** Files scoped to this conversation. */
  readonly files: CaseFiles;
  /** This plugin's storage, agent-wide and per case. */
  readonly store: PluginStore;
  /** The conversation's case. */
  readonly case: CaseContext;
  /** Other cases, when the plugin declared `{ cases: true }`. */
  readonly cases?: PluginCases;
  /** Run `fn` at most once per tool call and key; a replay returns the value. */
  once<T extends JsonValue>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Announce this plugin's own event to the other plugins' `onPluginEvent` hooks. */
  emit(this: void, name: string, data: JsonValue): void;
}

/**
 * A tool defined by reework's contract. Made only by `defineTool`, `gatedAction`
 * and `codingTools()`; a plugin can no longer hand in a raw pi-durable
 * registration. Startup rejects any other value (for JavaScript plugins).
 */
export interface ReeworkTool<TParameters extends TSchema = TSchema> {
  readonly __reworkTool: true;
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly replay?: "safe" | "unsafe";
  /** This tool's output is outside content (fetched pages, MCP replies, documents). */
  readonly external?: boolean;
  execute(args: Static<TParameters>, ctx: ToolContext): Promise<string | ToolResult>;
}

export interface DefineToolInput<TParameters extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  /** Tool argument schema, built with `Type` (re-exported). */
  readonly parameters: TParameters;
  /** Whether an interrupted call may rerun on recovery. Default `unsafe`. */
  readonly replay?: "safe" | "unsafe";
  /** This tool's output is outside content; hooks and later requests see it. */
  readonly external?: boolean;
  execute(args: Static<TParameters>, ctx: ToolContext): Promise<string | ToolResult>;
}

/** Define a reework tool. */
/** Guard: is this a reework tool (made by `defineTool`, `gatedAction` or `codingTools()`)? */
export function isReeworkTool(value: unknown): value is ReeworkTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __reworkTool?: unknown }).__reworkTool === true
  );
}

export function defineTool<TParameters extends TSchema>(
  def: DefineToolInput<TParameters>,
): ReeworkTool<TParameters> {
  return {
    __reworkTool: true,
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.replay === undefined ? {} : { replay: def.replay }),
    ...(def.external === true ? { external: true } : {}),
    execute: (args, ctx) => def.execute(args, ctx),
  };
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

export interface SectionRenderContext {
  readonly conversationId: string;
}

/** Define a system-prompt section rendered for each conversation. */
export function section(
  key: string,
  render: (ctx: SectionRenderContext) => string | Promise<string>,
  opts?: { readonly tag?: boolean },
): PromptSection {
  return durableSection(
    key,
    (input: PromptInput) => render({ conversationId: String(input.conversationId) }),
    opts,
  );
}

// ---------------------------------------------------------------------------
// Plugin hooks (§2).
// ---------------------------------------------------------------------------

/** The context a hook receives. */
export interface PluginHookContext {
  readonly conversationId: string;
  /** The named models this plugin declared. */
  readonly models: PluginModels;
  /** Requests with a declared secret applied. */
  readonly secrets: PluginSecrets;
  /** This plugin's storage, agent-wide and per case. */
  readonly store: PluginStore;
  /** Files scoped to this conversation. */
  readonly files: CaseFiles;
  /** The conversation's case. */
  readonly case: CaseContext;
  /** A value computed once per task attempt and reused on retry. */
  memo<T extends JsonValue>(name: string, compute: () => Promise<T>): Promise<T>;
  /** Announce this plugin's own event to the other plugins' `onPluginEvent` hooks. */
  emit(this: void, name: string, data: JsonValue): void;
}

/** The context an event hook receives: a run hook's bindings without `memo`.
 *  For a model call with no conversation (a plugin's setup or a route), the context
 *  is agent-level: `conversationId`, `files` and `case` are absent, and `store.case`
 *  is absent too; `store.agent` still works. */
export interface PluginEventContext {
  readonly conversationId?: string;
  /** The named models this plugin declared. */
  readonly models: PluginModels;
  /** Requests with a declared secret applied. */
  readonly secrets: PluginSecrets;
  /** This plugin's storage, agent-wide and (with a conversation) per case. */
  readonly store: PluginStore;
  /** Files scoped to this conversation; absent for agent-level entries. */
  readonly files?: CaseFiles;
  /** The conversation's case; absent for agent-level entries. */
  readonly case?: CaseContext;
  /** Other cases, when the plugin declared `{ cases: true }`. */
  readonly cases?: PluginCases;
  /** Announce this plugin's own event to the other plugins' `onPluginEvent` hooks. */
  emit(this: void, name: string, data: JsonValue): void;
}

/** An event one plugin emitted for the others to observe. */
export interface PluginEvent {
  /** The emitting plugin's own event name, a free-form string (`budget.warning`). */
  readonly name: string;
  /** The event payload; strict JSON. */
  readonly data: JsonValue;
  /** The plugin that emitted it; it never receives its own event. */
  readonly plugin: string;
  /** The emitting context's conversation; absent for `setup` and routes. */
  readonly conversationId?: string;
  readonly at: number;
}

/** One model call that returned usage, for `onModelUsage`. */
export interface ModelUsageEvent {
  /** `run` for the conversation's main model, `plugin` for a named-model call. */
  readonly source: "run" | "plugin";
  /** The plugin that made a named-model call; absent for a run's main model. */
  readonly plugin?: string;
  /** The named model, or `main` for the conversation model. */
  readonly model: string;
  /** The conversation, when the call belongs to one. */
  readonly conversationId?: string;
  readonly usage: ModelUsage;
  readonly at: number;
}

/** The call a `beforeModelCall` hook sees. */
export interface ModelCallRequest {
  /** The plugin making the call. */
  readonly plugin: string;
  readonly model: string;
  /** The conversation, when the call belongs to one. */
  readonly conversationId?: string;
}

/** A plugin used a secret: a raw read or a request with it applied. */
export interface SecretUseEvent {
  /** The plugin that used the secret. */
  readonly plugin: string;
  readonly name: string;
  readonly kind: "get" | "fetch" | "model";
  /** Whether the secret was used, refused, or the use failed. */
  readonly outcome: "used" | "refused" | "failed";
  readonly at: number;
  /** The conversation the use belongs to; absent for agent-level work. */
  readonly conversationId?: string;
}

/** The hooks a plugin may provide, run in plugin declaration order. */
export interface PluginHooks {
  beforeModelRequest?(
    input: { messages: ModelMessage[] },
    ctx: PluginHookContext,
  ): Promise<{ messages: ModelMessage[] } | { stop: string } | void>;
  afterModelResponse?(
    input: { message: ModelMessage; usage?: ModelUsage },
    ctx: PluginHookContext,
  ): Promise<void>;
  beforeTool?(
    input: { name: string; args: Record<string, unknown>; callId: string; external?: boolean },
    ctx: PluginHookContext,
  ): Promise<{ block: string } | { args: Record<string, unknown> } | void>;
  afterTool?(
    call: { name: string; args: Record<string, unknown>; callId: string; external?: boolean },
    result: ToolResult,
    ctx: PluginHookContext,
  ): Promise<ToolResult | void>;
  onAnswer?(
    input: { text: string; submissionId: string; from?: Author },
    ctx: PluginHookContext,
  ): Promise<{ continue: string } | void>;
  beforeCompaction?(
    input: { reason: string; messages: ModelMessage[] },
    ctx: PluginHookContext,
  ): Promise<{ summary: string } | { decline: true } | void>;
  /** Input was admitted (not a duplicate); it covers every source of input. */
  onInput?(
    input: { conversationId: string; submissionId: string; content: string; from?: Author },
    ctx: PluginEventContext,
  ): Promise<void>;
  /** A gate proposal opened, before any decision. */
  onProposalOpened?(input: { proposal: Proposal }, ctx: PluginEventContext): Promise<void>;
  /** A gate proposal was settled by a decision. */
  onDecision?(
    input: { proposal: Proposal; decision: GateDecision },
    ctx: PluginEventContext,
  ): Promise<void>;
  /** A case's status became `closed` (from `open` or `waiting`). */
  onCaseClosed?(input: { case: Case }, ctx: PluginEventContext): Promise<void>;
  /** A closed case became `open` or `waiting`, through input or an update. */
  onCaseReopened?(
    input: { case: Case; cause: "input" | "update" },
    ctx: PluginEventContext,
  ): Promise<void>;
  /** A model call returned usage: a run's main model or a plugin's named-model call. */
  onModelUsage?(input: ModelUsageEvent, ctx: PluginEventContext): Promise<void>;
  /** A plugin used a secret: a raw read or a request with it applied. */
  onSecretUse?(input: SecretUseEvent, ctx: PluginEventContext): Promise<void>;
  /** Before any `ctx.models.complete`; `{ refuse }` makes the call throw `ModelCallRefused`. */
  beforeModelCall?(
    input: ModelCallRequest,
    ctx: PluginEventContext,
  ): Promise<{ refuse: string } | void>;
  /** Another plugin emitted an event with `ctx.emit`; the emitter never receives its own. */
  onPluginEvent?(input: PluginEvent, ctx: PluginEventContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin / built plugin / extension.
// ---------------------------------------------------------------------------

/** What a plugin's `setup` receives once the engine is open. */
export interface PluginSetupContext<TConfig> {
  readonly host: AgentHost;
  readonly store: PluginStore;
  /** Requests with a declared secret applied. */
  readonly secrets: PluginSecrets;
  readonly config: TConfig;
  /** Aborted when the agent begins to stop; a loop started here breaks out on it. */
  readonly signal: AbortSignal;
  /** This plugin's directory beside the agent's storage. */
  readonly dataDir: string;
  /**
   * The named models this plugin declared, for work outside a run (a background
   * loop started here). Usable for the agent's whole life, not only during setup.
   */
  readonly models: PluginModels;
  /** Announce this plugin's own event; it reaches consumers agent-level (no conversation). */
  emit(this: void, name: string, data: JsonValue): void;
}

/** What a plugin's `routes(app, ctx)` receives. */
export interface PluginRouteContext<TConfig> {
  readonly host: AgentHost;
  readonly store: PluginStore;
  /** Requests with a declared secret applied. */
  readonly secrets: PluginSecrets;
  readonly config: TConfig;
  /** Aborted when the agent begins to stop. */
  readonly signal: AbortSignal;
  /** This plugin's directory beside the agent's storage. */
  readonly dataDir: string;
  /** The named models this plugin declared, for a route handler's own work. */
  readonly models: PluginModels;
  /** Announce this plugin's own event; it reaches consumers agent-level (no conversation). */
  emit(this: void, name: string, data: JsonValue): void;
}

/** What a plugin factory returns for one config. */
export interface BuiltPlugin<TConfig = unknown> {
  readonly tools?: readonly ReeworkTool[];
  readonly sections?: readonly PromptSection[];
  readonly hooks?: PluginHooks;
  /** Mount HTTP routes under `/plugins/<name>` after setup. */
  routes?(app: Hono, ctx: PluginRouteContext<TConfig>): void;
  /** Runtime wiring after the engine opens (watchers, channel transports). */
  setup?(ctx: PluginSetupContext<TConfig>): void | Promise<void>;
  /** Release what the factory or `setup` opened; runs once, on stop, before the engine closes. */
  stop?(): void | Promise<void>;
  /** At most one plugin per agent may provide each conversation's workspace. */
  readonly workspace?: WorkspaceProvider;
}

/** A plugin: a factory from its config to the tools, sections and hooks it adds. */
export interface ReeworkPlugin<TConfig = unknown> {
  readonly kind: "reework.plugin";
  /** Unique plugin name; also the name of its pi-durable extension. */
  readonly name: string;
  /** Build the plugin for one config; a factory may await discovery first. */
  build(config: TConfig): BuiltPlugin<TConfig> | Promise<BuiltPlugin<TConfig>>;
  /** Named models this plugin may call; each must be declared by the agent. */
  readonly models?: readonly string[];
  /** Secrets this plugin may use; each must be declared by the agent. */
  readonly secrets?: readonly string[];
  /** Declare the `ctx.cases` capability to reach other cases. */
  readonly cases?: boolean;
}

export function definePlugin<
  TConfig = unknown,
  TReturn extends BuiltPlugin<TConfig> | Promise<BuiltPlugin<TConfig>> = BuiltPlugin<TConfig>,
>(
  name: string,
  factory: (config: TConfig) => TReturn,
  options: {
    readonly models?: readonly string[];
    readonly secrets?: readonly string[];
    readonly cases?: boolean;
  } = {},
): {
  readonly kind: "reework.plugin";
  readonly name: string;
  readonly models: readonly string[];
  readonly secrets: readonly string[];
  readonly cases: boolean;
  /** The factory's own return type: a built plugin, or a promise of one. */
  build(config: TConfig): TReturn;
} {
  return {
    kind: "reework.plugin",
    name,
    build: factory,
    models: options.models ?? [],
    secrets: options.secrets ?? [],
    cases: options.cases === true,
  };
}

export function isReeworkPlugin(value: unknown): value is ReeworkPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "reework.plugin"
  );
}

/** A gated action's `run`, attached to its tool so the resumed task can dispatch it. */
const GATED_RUN = Symbol.for("reework.gatedRun");

/** Marks a rework tool as a gated action carrying its `run`. */
export function markGatedTool<T extends ReeworkTool>(tool: T, run: unknown): T {
  return Object.assign(tool, { [GATED_RUN]: run });
}

/** The gated `run` a tool carries, if any. */
export function gatedRunOf(tool: unknown): unknown {
  return (tool as { [GATED_RUN]?: unknown })[GATED_RUN];
}

/**
 * Convert a reework tool to the pi-durable registration the registry installs.
 * The reework `ToolContext` is built from the pi-durable execution api; its
 * `models`, `files`, `store` and `case` members are filled by the host when the
 * tool runs (later tasks wire them in).
 */
export function toDurableTool(
  tool: ReeworkTool,
  pluginName = "plugin",
  bindings?: PluginBindings,
): ToolRegistration {
  const durable = durableDefineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: tool.replay ?? "unsafe",
    async execute(args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
      const { ctx, modelCalls } = buildToolContext(api, context, pluginName, bindings);
      const result = await tool.execute(args, ctx);
      return toDurableResult(result, modelCalls, tool.external === true);
    },
  });
  const run = gatedRunOf(tool);
  if (run) {
    return markGated(
      durable,
      run as (
        ctx: GatedActionRunContext,
        decision: GateDecision,
        args: JsonValue,
      ) => Promise<unknown>,
    );
  }
  return durable;
}

/** The raw pi-durable execution handle a framework tool (a gated action) needs. */
export interface ToolInternal {
  readonly api: ToolExecutionApi;
  readonly context: Context;
}
const TOOL_INTERNAL = Symbol.for("reework.toolInternal");

/** The raw execution handle stashed on a tool context, for framework tools only. */
export function toolInternal(ctx: ToolContext): ToolInternal {
  return (ctx as unknown as { [TOOL_INTERNAL]: ToolInternal })[TOOL_INTERNAL];
}

/** Build the rework tool context a tool call receives. */
/** One named-model call made during a tool or gated-action execution. */
export interface NamedModelCall {
  readonly model: string;
  readonly usage: Usage;
}

/** The per-call spend a surface sees, derived from `NamedModelCall`s. */
export function modelUsageOf(calls: readonly NamedModelCall[]): ModelCallUsage[] {
  return calls.map((call) => ({
    model: call.model,
    inputTokens: call.usage.input,
    outputTokens: call.usage.output,
  }));
}

function buildToolContext(
  api: ToolExecutionApi,
  context: Context,
  pluginName: string,
  bindings?: PluginBindings,
): { ctx: ToolContext; modelCalls: NamedModelCall[] } {
  let fallback: AbortSignal | undefined;
  const signal = context.abortSignal ?? (fallback ??= new AbortController().signal);
  const backend: StoreBackend = { commit: (fn) => api.commit(fn, context) };
  const modelCalls: NamedModelCall[] = [];
  const cases = makePluginCases(pluginName, bindings);
  const made: ToolContext = {
    conversationId: String(api.conversationId),
    signal,
    emit: makePluginEmit(pluginName, bindings, String(api.conversationId), {
      taskId: String(api.taskId),
      signal,
    }),
    output: (chunk) => api.output(chunk),
    store: createPluginStore(backend, pluginName, api.conversationId),
    secrets: makePluginSecrets(pluginName, bindings, String(api.conversationId)),
    models: makePluginModels(
      pluginName,
      bindings,
      (call) => modelCalls.push(call),
      String(api.conversationId),
      signal,
    ),
    files: makeFileContext(String(api.conversationId), bindings),
    case: makeCaseContext(String(api.conversationId), bindings),
    ...(cases === undefined ? {} : { cases }),
    once: (key, fn) => once(api, key, context, fn),
  };
  (made as unknown as { [TOOL_INTERNAL]: ToolInternal })[TOOL_INTERNAL] = { api, context };
  return { ctx: made, modelCalls };
}

/** Convert a reework tool result to the pi-durable execution result. */
function toDurableResult(
  result: string | ToolResult,
  modelCalls: readonly NamedModelCall[] = [],
  toolExternal = false,
): ToolExecutionResult {
  const base: ToolExecutionResult =
    typeof result === "string"
      ? { output: [{ type: "text", text: result }] }
      : {
          output: [{ type: "text", text: result.output }],
          ...(result.isError === true ? { isError: true } : {}),
          ...(result.details === undefined ? {} : { details: result.details }),
        };
  const metadata: FrameworkMetadata = {
    ...(modelCalls.length > 0 ? { modelUsage: modelUsageOf(modelCalls) } : {}),
    ...(toolExternal || (typeof result !== "string" && result.external === true)
      ? { external: true }
      : {}),
  };
  if (metadata.modelUsage === undefined && metadata.external === undefined) return base;
  return {
    ...base,
    details: attachFrameworkMetadata(base.details, metadata),
    ...(modelCalls.length > 0 ? { usage: sumUsage(modelCalls) } : {}),
  };
}

/** Core metadata carried in `details.reework`: model spend and the external flag. */
interface FrameworkMetadata {
  readonly modelUsage?: readonly ModelCallUsage[];
  readonly external?: boolean;
}

/** Add the framework's metadata beside a tool's own details. */
function attachFrameworkMetadata(
  details: JsonValue | undefined,
  metadata: FrameworkMetadata,
): JsonValue {
  const framework: { [key: string]: JsonValue } = {};
  if (metadata.modelUsage !== undefined) {
    framework.modelUsage = metadata.modelUsage as unknown as JsonValue;
  }
  if (metadata.external === true) framework.external = true;
  return mergeReework(details, framework);
}

/** Merge core metadata into a details object's `reework` slot, keeping plugin details. */
function mergeReework(
  details: JsonValue | undefined,
  reework: { [key: string]: JsonValue },
): JsonValue {
  if (details === undefined) return { reework };
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const existing = details as { [key: string]: JsonValue };
    const current = existing["reework"];
    const merged =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? { ...(current as { [key: string]: JsonValue }), ...reework }
        : reework;
    return { ...existing, reework: merged };
  }
  return { value: details, reework };
}

/** A details object's `reework` slot, when it carries one. */
function reeworkOf(details: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const current = (details as { [key: string]: JsonValue })["reework"];
  return typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as { [key: string]: JsonValue })
    : undefined;
}

/** Whether a result's details carry the framework's external flag. */
function externalOfDetails(details: JsonValue | undefined): boolean {
  return reeworkOf(details)?.["external"] === true;
}

/**
 * Mark a result external and re-attach the framework's metadata, OR-ing the
 * sticky flag. A hook's fresh object keeps the flag and the original spend.
 */
function markExternal(
  result: ToolResult,
  external: boolean,
  base: { [key: string]: JsonValue } | undefined,
): ToolResult {
  const reework: { [key: string]: JsonValue } = { ...reeworkOf(result.details), ...base };
  if (external) reework.external = true;
  else delete reework.external;
  const details =
    Object.keys(reework).length > 0 ? mergeReework(result.details, reework) : result.details;
  return {
    output: result.output,
    ...(result.isError === true ? { isError: true } : {}),
    ...(details === undefined ? {} : { details }),
    ...(external ? { external: true } : {}),
  };
}

/** Sum the spend of a tool call's named-model calls into one usage record. */
function sumUsage(calls: readonly NamedModelCall[]): Usage {
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const { usage } of calls) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    if (usage.cacheWrite1h !== undefined) {
      total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
    }
    if (usage.reasoning !== undefined) {
      total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    }
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Context members, filled in by later tasks (models, files, store, case).
// ---------------------------------------------------------------------------

/** The plugin-facing context members, with a real store when one is supplied. */
export function createPluginContextMembers(
  store?: PluginStore,
  conversationId?: string,
  bindings?: PluginBindings,
  pluginName = "?",
  collect?: (call: NamedModelCall) => void,
  includeCases = false,
  signal?: AbortSignal,
): Pick<ToolContext, "models" | "secrets" | "files" | "store" | "case" | "emit"> & {
  cases?: PluginCases;
} {
  const cases = includeCases ? makePluginCases(pluginName, bindings) : undefined;
  return {
    emit: makePluginEmit(pluginName, bindings, conversationId),
    models: makePluginModels(pluginName, bindings, collect, conversationId, signal),
    secrets: makePluginSecrets(pluginName, bindings, conversationId),
    files: conversationId ? makeFileContext(conversationId, bindings) : stubFiles(),
    store: store ?? uninitializedStore(),
    case: conversationId ? makeCaseContext(conversationId, bindings) : stubCase(),
    ...(cases === undefined ? {} : { cases }),
  };
}

function uninitializedStore(): PluginStore {
  return {
    agent: {
      get: undefinedGet,
      set: undefinedGet,
      update: undefinedGet,
      delete: undefinedGet,
      list: undefinedGet,
    },
    case: {
      get: undefinedGet,
      set: undefinedGet,
      update: undefinedGet,
      delete: undefinedGet,
      list: undefinedGet,
    },
  } as PluginStore;
}
const undefinedGet = (): never => {
  throw new Error("plugin storage is not wired in this build");
};

// Named models and host-backed case/file access: each agent binds its own
// capabilities object in bootstrap and passes it where contexts are built, so
// two agents in one process never share them.
export interface PluginCaseAccess {
  get(conversationId: string): Promise<Case>;
  update(conversationId: string, patch: CasePatch): Promise<Case>;
}

export interface PluginCasesAccess {
  list(filter: ListCasesFilter): Promise<Case[]>;
  get(id: string): Promise<Case>;
  snapshot(id: string): Promise<ConversationSnapshot>;
  submit(
    id: string,
    text: string,
    options: { readonly from?: Author },
  ): Promise<{ readonly submissionId: string }>;
  decide(input: {
    readonly proposalId: string;
    readonly decision: PluginDecision;
    readonly decidedBy?: Author;
  }): Promise<void>;
  update(id: string, patch: CasePatch): Promise<Case>;
}

export interface PluginFilesAccess {
  list(conversationId: string): Promise<FileRecord[]>;
  read(conversationId: string, id: string): Promise<{ record: FileRecord; bytes: Uint8Array }>;
  add(
    conversationId: string,
    input: { name: string; mimeType: string; bytes: Uint8Array; source: "plugin" },
  ): Promise<FileRecord>;
}

/** The capabilities one agent lends its plugins: its model catalog, each
 *  plugin's lent names, and its host-backed case and file access. */
export interface PluginBindings {
  catalog?: Models;
  /** The agent has no model: it refuses runs and does not resume one after a gate. */
  headless?: boolean;
  /** The agent's secrets: fetch applies one, get returns it. */
  secrets?: SecretsAccess;
  readonly lent: ReadonlyMap<string, readonly string[]>;
  /** The plugins that declared `{ cases: true }`; the declaration is the grant. */
  readonly lentCases?: ReadonlySet<string>;
  /** A named model's request limiter, shared with its completions. */
  requestLimiter?: (name: string) => RequestLimiter | undefined;
  case?: PluginCaseAccess;
  cases?: PluginCasesAccess;
  files?: PluginFilesAccess;
  /**
   * The committed model context's user messages, oldest first, each with the
   * author of the entry that contributed it, so hooks can name an input's
   * author. Filled once the engine exists.
   */
  inputAuthors?: (
    conversationId: string,
  ) => Promise<readonly { timestamp?: number; from?: Author }[]>;
  /** The author of an input submission, so `onAnswer` can name who started the run. */
  inputFrom?: (conversationId: string, submissionId: string) => Promise<Author | undefined>;
  /**
   * The committed tool-result messages' external flags by call id, so a
   * message-returning hook cannot clear the flag for the hooks after it.
   */
  toolResultExternals?: (
    conversationId: string,
  ) => Promise<readonly { toolCallId: string; external: boolean }[]>;
  /** The engine's storage, for the plugin store run hooks get. Filled once the engine exists. */
  storage?: StoreBackend;
  /** Stop the run whose generation task is `taskId`; filled once the engine exists. */
  stopRun?: (conversationId: string, taskId: string, notice: RunStopNotice) => Promise<void>;
  /** Queue an `onModelUsage` event; filled once the agent's event queue exists. */
  modelUsage?: (event: ModelUsageEvent) => void;
  /** Queue a plugin's emitted event; filled once the agent's event queue exists. */
  emit?: (plugin: string, event: PluginEvent, depth?: number) => void;
  /** Hold a tool task's emitted events until its round's tools have committed. */
  bufferEmit?: (taskId: string, event: PluginEvent) => void;
  /** Queue a round's tool emits, and drop the conversation's stale buffered emits. */
  flushEmits?: (conversationId: string, taskIds: ReadonlySet<string>) => void;
  /**
   * The coordinator list of `beforeModelCall` hooks, in plugin declaration order:
   * resolves the first refusal, or undefined when no hook refused. Built from the
   * built plugins, so every `ctx.models.complete` sees it (a plugin's models have
   * no access to other plugins' hooks).
   */
  beforeModelCall?: (call: ModelCallRequest) => Promise<string | undefined>;
}

/** Build the secrets surface for one plugin (its declaration is checked when used). */
export function makePluginSecrets(
  pluginName: string,
  bindings?: PluginBindings,
  conversationId?: string,
): PluginSecrets {
  const required = () => {
    if (!bindings?.secrets) throw new Error("plugin secrets are not wired in this build");
    return bindings.secrets;
  };
  return {
    fetch: (name, url, init) => required().fetch(pluginName, name, url, init, conversationId),
    get: (name) => required().get(pluginName, name, conversationId),
  };
}

/** Build the emit surface for one plugin: validate, copy and queue its event. */
export function makePluginEmit(
  pluginName: string,
  bindings?: PluginBindings,
  conversationId?: string,
  defer?: { readonly taskId: string; readonly signal?: AbortSignal },
  chainDepth = 0,
): (name: string, data: JsonValue) => void {
  return (name, data) => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`plugin "${pluginName}" event name must be a non-empty string`);
    }
    if (name.length > 128) {
      throw new Error(`plugin "${pluginName}" event name must be at most 128 characters`);
    }
    if (!/^[\x20-\x7E]+$/.test(name)) {
      throw new Error(
        `plugin "${pluginName}" event "${name}" name must be printable characters without control characters`,
      );
    }
    let copied: JsonValue;
    try {
      copied = copyJson(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`plugin "${pluginName}" event "${name}" data must be JSON: ${message}`, {
        cause: error,
      });
    }
    const bytes = Buffer.byteLength(JSON.stringify(copied), "utf8");
    if (bytes > 256 * 1024) {
      throw new Error(
        `plugin "${pluginName}" event "${name}" payload must be at most 256 KB (got ${bytes} bytes)`,
      );
    }
    const event: PluginEvent = {
      name,
      data: copied,
      plugin: pluginName,
      ...(conversationId === undefined ? {} : { conversationId }),
      at: Date.now(),
    };
    if (defer) {
      if (defer.signal?.aborted) return;
      if (!bindings?.bufferEmit) throw new Error("plugin events are not wired in this build");
      bindings.bufferEmit(defer.taskId, event);
      return;
    }
    if (!bindings?.emit) throw new Error("plugin events are not wired in this build");
    bindings.emit(pluginName, event, chainDepth);
  };
}

/** OpenAI-compatible servers cap one embeddings request's inputs. */
const EMBED_BATCH_SIZE = 512;

export function makePluginModels(
  pluginName: string,
  bindings?: PluginBindings,
  collect?: (call: NamedModelCall) => void,
  conversationId?: string,
  signal?: AbortSignal,
): PluginModels {
  const lent = bindings?.lent.get(pluginName) ?? [];
  const resolve = (name: string) => {
    const catalog = bindings?.catalog;
    if (!catalog) {
      throw new Error(`plugin ${pluginName}: named models are not wired in this build`);
    }
    if (name === "main") {
      throw new Error(`plugin ${pluginName}: "main" names the conversation model`);
    }
    if (!lent.includes(name)) {
      throw new Error(`plugin "${pluginName}" did not request model "${name}"`);
    }
    const provider = `reework.model.${name}`;
    const model = catalog.getModels(provider)[0];
    if (!model) {
      throw new Error(`plugin ${pluginName}: model "${name}" is not available`);
    }
    return { catalog, model };
  };
  return {
    complete: async (name, input) => {
      const { catalog, model } = resolve(name);
      if (hasImage(input.messages) && !(model.input as readonly string[]).includes("image")) {
        throw new Error(`model "${name}" does not accept image input`);
      }
      const refusal = await bindings?.beforeModelCall?.({
        plugin: pluginName,
        model: name,
        ...(conversationId === undefined ? {} : { conversationId }),
      });
      if (refusal !== undefined) throw new ModelCallRefused(refusal);
      const result = await catalog.complete(
        model,
        { systemPrompt: input.system, messages: toAiMessages(input.messages) },
        { signal: input.signal },
      );
      if (result.usage) {
        collect?.({ model: name, usage: result.usage });
        bindings?.modelUsage?.({
          source: "plugin",
          plugin: pluginName,
          model: name,
          ...(conversationId === undefined ? {} : { conversationId }),
          usage: toModelUsage(result.usage),
          at: Date.now(),
        });
      }
      return { text: assistantText(result), usage: mapUsage(result.usage) };
    },
    embed: async (name, texts, options) => {
      if (texts.length === 0) return { embeddings: [] };
      const { catalog, model } = resolve(name);
      if (model.api !== "openai-completions" && model.api !== "openai-responses") {
        throw new ModelHasNoEmbeddings(name);
      }
      const refusal = await bindings?.beforeModelCall?.({
        plugin: pluginName,
        model: name,
        ...(conversationId === undefined ? {} : { conversationId }),
      });
      if (refusal !== undefined) throw new ModelCallRefused(refusal);
      const auth = await catalog.getAuth(model);
      const baseUrl = (auth?.auth.baseUrl ?? model.baseUrl ?? "").replace(/\/+$/, "");
      if (!baseUrl) {
        throw new Error(`plugin ${pluginName}: model "${name}" has no base URL`);
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const [key, value] of Object.entries(auth?.auth.headers ?? {})) {
        if (value !== null) headers[key] = value;
      }
      if (auth?.auth.apiKey) headers.authorization = `Bearer ${auth.auth.apiKey}`;
      const callSignal = combineSignals(signal, options?.signal);

      const requestBatch = async (batch: readonly string[]) => {
        const release = await bindings?.requestLimiter?.(name)?.acquire(callSignal);
        try {
          const timeoutMs = bindings?.secrets?.modelRequestTimeout?.() ?? 60_000;
          const requestSignal = combineSignals(callSignal, AbortSignal.timeout(timeoutMs));
          let response: Response;
          try {
            response = await fetch(`${baseUrl}/embeddings`, {
              method: "POST",
              headers,
              body: JSON.stringify({ model: model.id, input: batch }),
              ...(requestSignal === undefined ? {} : { signal: requestSignal }),
            });
          } catch (error) {
            if (callSignal?.aborted) throw error;
            if ((error as { name?: string }).name === "TimeoutError") {
              throw new EmbeddingTimeoutError(pluginName, name, timeoutMs);
            }
            throw error;
          }
          if (!response.ok) {
            throw new Error(
              `plugin ${pluginName}: model "${name}" embeddings request failed with ${response.status}`,
            );
          }
          const text = await response.text();
          let body: {
            data?: { index?: number; embedding?: number[] }[];
            usage?: { prompt_tokens?: number; total_tokens?: number };
          };
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            throw new EmbeddingResponseInvalid(pluginName, name, "response is not JSON");
          }

          const data = body.data ?? [];
          if (data.length !== batch.length) {
            throw new EmbeddingResponseInvalid(
              pluginName,
              name,
              `expected ${batch.length} vectors, got ${data.length}`,
            );
          }
          const vectors: number[][] = [];
          const used = new Set<number>();
          let dimension: number | undefined;
          for (const item of data) {
            const index = item.index;
            if (
              typeof index !== "number" ||
              !Number.isInteger(index) ||
              index < 0 ||
              index >= batch.length
            ) {
              throw new EmbeddingResponseInvalid(
                pluginName,
                name,
                `item index ${String(index)} is not one of 0..${batch.length - 1}`,
              );
            }
            if (used.has(index)) {
              throw new EmbeddingResponseInvalid(pluginName, name, `duplicate index ${index}`);
            }
            if (!Array.isArray(item.embedding)) {
              throw new EmbeddingResponseInvalid(
                pluginName,
                name,
                `item ${index} has no embedding`,
              );
            }
            if (dimension === undefined) dimension = item.embedding.length;
            else if (item.embedding.length !== dimension) {
              throw new EmbeddingResponseInvalid(
                pluginName,
                name,
                `vectors have inconsistent dimensions (${dimension} and ${item.embedding.length})`,
              );
            }
            used.add(index);
            vectors[index] = item.embedding;
          }
          const usage: ModelUsage | undefined = body.usage
            ? {
                inputTokens: body.usage.prompt_tokens ?? 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: body.usage.total_tokens ?? body.usage.prompt_tokens ?? 0,
              }
            : undefined;
          return { embeddings: vectors, usage };
        } finally {
          release?.();
        }
      };

      const embeddings: number[][] = [];
      let usage: ModelUsage | undefined;
      for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
        const result = await requestBatch(texts.slice(start, start + EMBED_BATCH_SIZE));
        embeddings.push(...result.embeddings);
        if (result.usage) {
          usage =
            usage === undefined
              ? result.usage
              : {
                  inputTokens: usage.inputTokens + result.usage.inputTokens,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  totalTokens: usage.totalTokens + result.usage.totalTokens,
                };
        }
      }
      if (usage !== undefined) {
        bindings?.modelUsage?.({
          source: "plugin",
          plugin: pluginName,
          model: name,
          ...(conversationId === undefined ? {} : { conversationId }),
          usage,
          at: Date.now(),
        });
      }
      return { embeddings, ...(usage === undefined ? {} : { usage }) };
    },
  };
}

/** One abort signal from the context and the caller, or undefined when neither exists. */
function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  const signals = [a, b].filter((signal): signal is AbortSignal => signal !== undefined);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/** A pi-ai usage record as reework's typed token counts. */
function toModelUsage(usage: Usage): ModelUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function hasImage(messages: string | readonly ModelInputMessage[]): boolean {
  if (typeof messages === "string") return false;
  return messages.some(
    (m) =>
      typeof m.content !== "string" &&
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "image"),
  );
}

function toAiMessages(messages: string | readonly ModelInputMessage[]): Message[] {
  if (typeof messages === "string") {
    return [{ role: "user", content: messages }] as Message[];
  }
  return messages.map((m) => ({ role: m.role, content: m.content })) as Message[];
}

function mapUsage(usage: { input: number; output: number }): {
  inputTokens?: number;
  outputTokens?: number;
} {
  return { inputTokens: usage.input, outputTokens: usage.output };
}

function assistantText(message: AssistantMessage): string {
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

// Placeholder implementations for the context members later tasks wire in.
function stubFiles(): CaseFiles {
  return {
    list: () => {
      throw new Error("plugin files are not wired in this build");
    },
    read: () => {
      throw new Error("plugin files are not wired in this build");
    },
    add: () => {
      throw new Error("plugin files are not wired in this build");
    },
  };
}
function stubCase(): CaseContext {
  return {
    get: () => {
      throw new Error("plugin case access is not wired in this build");
    },
    update: () => {
      throw new Error("plugin case access is not wired in this build");
    },
  };
}

/** Read a conversation's case without a tool context (for the case section). */
export function readCase(conversationId: string, bindings?: PluginBindings): Promise<Case> {
  if (!bindings?.case) {
    return Promise.reject(new Error("plugin case access is not wired in this build"));
  }
  return bindings.case.get(conversationId);
}

/** Build the rework file context for one conversation. Added files are `plugin` files. */
function makeFileContext(conversationId: string, bindings?: PluginBindings): CaseFiles {
  const required = () => {
    if (!bindings?.files) throw new Error("plugin files are not wired in this build");
    return bindings.files;
  };
  return {
    list: () => required().list(conversationId),
    read: (id) => required().read(conversationId, id),
    add: (input) => required().add(conversationId, { ...input, source: "plugin" }),
  };
}

/** Build the cases capability for one plugin, when it declared `{ cases: true }`. */
export function makePluginCases(
  pluginName: string,
  bindings?: PluginBindings,
): PluginCases | undefined {
  if (!bindings?.lentCases?.has(pluginName)) return undefined;
  const required = () => {
    if (!bindings.cases) throw new Error("plugin cases are not wired in this build");
    return bindings.cases;
  };
  return {
    list: (filter = {}) => required().list(filter),
    get: (id) => required().get(id),
    snapshot: (id) => required().snapshot(id),
    submit: (id, text, options = {}) => required().submit(id, text, options),
    decide: (input) => required().decide(input),
    update: (id, patch) => required().update(id, patch),
  };
}

/** Build the rework case context for one conversation. */
function makeCaseContext(conversationId: string, bindings?: PluginBindings): CaseContext {
  const required = () => {
    if (!bindings?.case) throw new Error("plugin case access is not wired in this build");
    return bindings.case;
  };
  return {
    get: () => required().get(conversationId),
    update: (patch) => required().update(conversationId, patch),
  };
}
/** Turn a built plugin into the pi-durable extension the registry installs. */
export function toExtension(
  name: string,
  built: BuiltPlugin,
  bindings?: PluginBindings,
): Extension {
  const tools = (built.tools ?? []).map((tool) => {
    if (!isReeworkTool(tool)) {
      const toolName = (tool as { name?: string } | null)?.name ?? "?";
      throw new Error(
        `plugin "${name}" has an invalid tool "${toolName}": only defineTool, gatedAction or codingTools() values are accepted`,
      );
    }
    return toDurableTool(tool, name, bindings);
  });
  return defineExtension({
    name,
    tools,
    sections: built.sections ?? [],
    ...(built.hooks ? { hooks: buildHooks(name, built.hooks, bindings) } : {}),
  });
}

// ---------------------------------------------------------------------------
// Hook conversion: rework hook shape ⇄ pi-durable.
// ---------------------------------------------------------------------------

function buildHooks(
  name: string,
  hooks: PluginHooks,
  bindings?: PluginBindings,
): HookRegistration[] {
  const registration: HookRegistration[] = [];
  const hookCtx = (api: HookApi, context: Context): PluginHookContext =>
    makeHookContext(name, api, context, bindings);

  if (hooks.afterModelResponse || hooks.onAnswer) {
    registration.push(
      hook(GenerationTask, {
        afterResponse(message, api, context) {
          const usage = usageOf(message);
          if (!hooks.afterModelResponse) return undefined;
          return Promise.resolve(
            hooks.afterModelResponse(
              {
                message: reworkMessageFrom(message as unknown as Message),
                usage,
              },
              hookCtx(api, context),
            ),
          ).catch((err) => {
            logHookError(name, "afterModelResponse", err);
          });
        },
        onYield(answer, api, context) {
          if (!hooks.onAnswer) return undefined;
          const run = async () => {
            const live = await api.snapshot(LiveDoc, api.conversationId, context);
            const starting = live?.run?.inputs[0];
            let from: Author | undefined;
            if (starting !== undefined) {
              try {
                from = await bindings?.inputFrom?.(String(api.conversationId), String(starting));
              } catch {
                from = undefined;
              }
            }
            const next = await hooks.onAnswer!(
              {
                text: messageText(answer),
                submissionId: starting === undefined ? "" : String(starting),
                ...(from === undefined ? {} : { from }),
              },
              hookCtx(api, context),
            );
            if (!next?.continue) return undefined;
            return { continue: next.continue };
          };
          return run().catch((err) => {
            logHookError(name, "onAnswer", err);
            return undefined;
          });
        },
      }),
    );
  }

  if (hooks.beforeCompaction) {
    registration.push(
      hook(CompactionTask, {
        beforeCompact({ messages, entries, reason }, api, context) {
          const run = async () => {
            const next = await hooks.beforeCompaction!(
              { reason, messages: authoredCompactionMessages(entries, messages) },
              hookCtx(api, context),
            );
            if (!next) return undefined;
            if ("summary" in next) return { summary: next.summary };
            return { decline: true as const };
          };
          return run().catch((err) => {
            logHookError(name, "beforeCompaction", err);
            return undefined;
          });
        },
      }),
    );
  }

  return registration;
}

/** Build the rework hook context for one plugin. */
function makeHookContext(
  name: string,
  api: HookApi,
  context: Context,
  bindings?: PluginBindings,
  toolRound = false,
): PluginHookContext {
  return {
    conversationId: String(api.conversationId),
    ...createPluginContextMembers(
      bindings?.storage ? createPluginStore(bindings.storage, name, api.conversationId) : undefined,
      String(api.conversationId),
      bindings,
      name,
    ),
    emit: makePluginEmit(
      name,
      bindings,
      String(api.conversationId),
      toolRound
        ? {
            taskId: String(api.taskId),
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          }
        : undefined,
    ),
    models: makePluginModels(
      name,
      bindings,
      undefined,
      String(api.conversationId),
      context.abortSignal,
    ),
    files: makeFileContext(String(api.conversationId), bindings),
    case: makeCaseContext(String(api.conversationId), bindings),
    memo: async <T extends JsonValue>(key: string, compute: () => Promise<T>): Promise<T> => {
      const existing = await api.memo(key, context);
      if (existing !== undefined) return existing as T;
      return api.memo(key, await compute(), context) as Promise<T>;
    },
  };
}

// ---------------------------------------------------------------------------
// The tool-hook coordinator: one ToolTask hook that runs every plugin's
// beforeTool in declaration order (a `block` stops the rest) and reports a
// blocked call to the plugins declared after it via their afterTool, so an
// audit plugin sees every call either way (pi-durable does not run afterTool
// for a blocked call).
// ---------------------------------------------------------------------------

/** Build the single ToolTask hook registration that coordinates all plugins. */
export function buildToolHooks(
  plugins: readonly {
    readonly name: string;
    readonly hooks?: PluginHooks;
    readonly tools?: readonly ReeworkTool[];
  }[],
  bindings?: PluginBindings,
): HookRegistration | undefined {
  const any = plugins.filter(
    (p) => typeof p.hooks?.beforeTool === "function" || typeof p.hooks?.afterTool === "function",
  );
  if (any.length === 0) return undefined;
  // A tool's own flag marks every result it produces; a plugin cannot remove it.
  const externalTools = new Set<string>();
  for (const p of plugins) {
    for (const tool of p.tools ?? []) {
      if (tool.external === true) externalTools.add(tool.name);
    }
  }
  const toolIsExternal = (name: string): boolean => externalTools.has(name);
  return hook(ToolTask, {
    async beforeTool(call, api, context) {
      let args = call.arguments as Record<string, unknown>;
      const external = toolIsExternal(call.name);
      for (let i = 0; i < plugins.length; i++) {
        const p = plugins[i];
        if (!p.hooks?.beforeTool) continue;
        const res = await p.hooks.beforeTool(
          { name: call.name, args, callId: call.id, external },
          makeHookContext(p.name, api, context, bindings, true),
        );
        if (res && "block" in res) {
          // Report the blocked call to the plugins declared after this one. A
          // blocked result starts not external (no outside content was read); a
          // hook's flag sticks for the hooks after it, as in the afterTool chain.
          let blocked: ToolResult = { output: res.block, isError: true };
          let blockedExternal = false;
          for (let j = i + 1; j < plugins.length; j++) {
            const q = plugins[j];
            if (q.hooks?.afterTool) {
              const next = await q.hooks.afterTool(
                { name: call.name, args, callId: call.id, external },
                blocked,
                makeHookContext(q.name, api, context, bindings, true),
              );
              if (next) {
                blockedExternal =
                  blockedExternal || next.external === true || externalOfDetails(next.details);
                blocked = markExternal(next, blockedExternal, undefined);
              }
            }
          }
          return { block: res.block };
        }
        if (res && "args" in res) args = res.args;
      }
      return { arguments: args as never };
    },
    async afterTool(call, result, api, context) {
      const external = toolIsExternal(call.name);
      const base = reeworkOf(result.details);
      let flag = external || externalOfDetails(result.details);
      let current = markExternal(durableResultToRework(result), flag, base);
      for (let i = 0; i < plugins.length; i++) {
        const p = plugins[i];
        if (!p.hooks?.afterTool) continue;
        const next = await p.hooks.afterTool(
          {
            name: call.name,
            args: call.arguments as Record<string, unknown>,
            callId: call.id,
            external,
          },
          current,
          makeHookContext(p.name, api, context, bindings, true),
        );
        if (next) {
          flag = flag || next.external === true || externalOfDetails(next.details);
          current = markExternal(next, flag, base);
        }
      }
      return toDurableResult(current);
    },
  });
}

// ---------------------------------------------------------------------------
// The model-request coordinator: one GenerationTask hook that runs every
// plugin's beforeModelRequest in declaration order. A `{ stop }` ends the run
// before the request is made (the tool-round budget's abort path), and the first
// stop wins; later hooks do not run.
// ---------------------------------------------------------------------------

/** Build the single GenerationTask hook registration that coordinates beforeModelRequest. */
export function buildModelHooks(
  plugins: readonly { readonly name: string; readonly hooks?: PluginHooks }[],
  bindings?: PluginBindings,
): HookRegistration | undefined {
  const any = plugins.filter((p) => typeof p.hooks?.beforeModelRequest === "function");
  if (any.length === 0) return undefined;
  return hook(GenerationTask, {
    async beforeRequest({ messages }, api, context) {
      let current: readonly Message[] = messages;
      let replaced = false;
      for (const p of plugins) {
        if (!p.hooks?.beforeModelRequest) continue;
        let next: { messages: ModelMessage[] } | { stop: string } | void;
        try {
          next = await p.hooks.beforeModelRequest(
            { messages: await authoredRequestMessages(p.name, current, api, bindings) },
            makeHookContext(p.name, api, context, bindings),
          );
        } catch (err) {
          logHookError(p.name, "beforeModelRequest", err);
          continue;
        }
        if (!next) continue;
        if ("stop" in next) {
          const notice: RunStopNotice = { plugin: p.name, reason: next.stop };
          // End the run the way the tool-round budget does: abort it and wait for
          // its generation. The run-scoped abort is not awaited (we run inside that task).
          try {
            await bindings?.stopRun?.(String(api.conversationId), String(api.taskId), notice);
          } catch (err) {
            logHookError(p.name, "beforeModelRequest", err);
          }
          await endRun(() => Promise.resolve(), (api as { signal?: AbortSignal }).signal);
          return undefined;
        }
        current = next.messages.map(hookMessageTo);
        replaced = true;
      }
      return replaced ? { messages: current } : undefined;
    },
  });
}

// ---------------------------------------------------------------------------
// The named-model call coordinator: every `ctx.models.complete` runs the
// plugins' beforeModelCall hooks in declaration order; the first refusal wins.
// ---------------------------------------------------------------------------

/** Build the coordinator that runs before every named-model call. */
export function buildModelCallHooks(
  plugins: readonly { readonly name: string; readonly hooks?: PluginHooks }[],
  bindings?: PluginBindings,
): (call: ModelCallRequest) => Promise<string | undefined> {
  const watchers = plugins.filter((p) => typeof p.hooks?.beforeModelCall === "function");
  if (watchers.length === 0) return async () => undefined;
  return async (call) => {
    for (const p of watchers) {
      try {
        const next = await p.hooks!.beforeModelCall!(
          call,
          makeEventContext(p.name, bindings, call.conversationId),
        );
        if (next && "refuse" in next) return next.refuse;
      } catch (err) {
        logHookError(p.name, "beforeModelCall", err);
      }
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// The run-usage coordinator: one GenerationTask hook that emits one `onModelUsage`
// event per main-model response, however many plugins declare the event hook.
// ---------------------------------------------------------------------------

/** Build the single afterResponse hook that reports a run's model usage. */
export function buildUsageHooks(
  plugins: readonly { readonly name: string; readonly hooks?: PluginHooks }[],
  bindings?: PluginBindings,
): HookRegistration | undefined {
  if (!plugins.some((p) => typeof p.hooks?.onModelUsage === "function")) return undefined;
  return hook(GenerationTask, {
    afterResponse(message, api) {
      const usage = usageOf(message);
      if (!usage) return undefined;
      bindings?.modelUsage?.({
        source: "run",
        model: "main",
        conversationId: String(api.conversationId),
        usage,
        at: Date.now(),
      });
      return undefined;
    },
  });
}

/** Build the afterTools hook that queues a round's tool emits once the tools committed. */
export function buildPluginEventFlushHook(bindings?: PluginBindings): HookRegistration {
  return hook(GenerationTask, {
    async afterTools(_assistant, results, api, context) {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const committed = new Set(results.map(String));
      const taskIds = new Set<string>();
      for (const slot of live?.tools ?? []) {
        if (
          slot.entry !== undefined &&
          slot.taskId !== undefined &&
          committed.has(String(slot.entry))
        ) {
          taskIds.add(String(slot.taskId));
        }
      }
      // A nested call belongs to the round of the tool that made it.
      let added = true;
      while (added) {
        added = false;
        for (const slot of live?.nestedTools ?? []) {
          if (taskIds.has(String(slot.taskId))) continue;
          if (taskIds.has(String(slot.parentTaskId))) {
            taskIds.add(String(slot.taskId));
            added = true;
          }
        }
      }
      bindings?.flushEmits?.(String(api.conversationId), taskIds);
    },
  });
}

/** A named model's embeddings request did not answer before its timeout. */
export class EmbeddingTimeoutError extends Error {
  readonly plugin: string;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(plugin: string, model: string, timeoutMs: number) {
    super(`plugin "${plugin}" model "${model}" embeddings request timed out after ${timeoutMs} ms`);
    this.name = "EmbeddingTimeoutError";
    this.plugin = plugin;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }
}

/** A named model returned an embeddings response that does not fit the request. */
export class EmbeddingResponseInvalid extends Error {
  readonly plugin: string;
  readonly model: string;
  readonly reason: string;

  constructor(plugin: string, model: string, reason: string) {
    super(`plugin "${plugin}" model "${model}" returned an invalid embeddings response: ${reason}`);
    this.name = "EmbeddingResponseInvalid";
    this.plugin = plugin;
    this.model = model;
    this.reason = reason;
  }
}

/** A named model whose protocol has no OpenAI-compatible embeddings endpoint. */
export class ModelHasNoEmbeddings extends Error {
  readonly model: string;

  constructor(model: string) {
    super(`model "${model}" has no embeddings`);
    this.name = "ModelHasNoEmbeddings";
    this.model = model;
  }
}

/** A named-model call a plugin refused; the caller receives it as an error. */
export class ModelCallRefused extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`model call refused: ${reason}`);
    this.name = "ModelCallRefused";
    this.reason = reason;
  }
}

/** Build the context one plugin receives for one event (agent-level without a conversation). */
export function makeEventContext(
  name: string,
  bindings?: PluginBindings,
  conversationId?: string,
  emitDepth = 0,
): PluginEventContext {
  const conversation =
    conversationId === undefined
      ? undefined
      : (Number(conversationId) as unknown as ConversationId);
  const cases = makePluginCases(name, bindings);
  return {
    emit: makePluginEmit(name, bindings, conversationId, undefined, emitDepth),
    models: makePluginModels(name, bindings, undefined, conversationId),
    secrets: makePluginSecrets(name, bindings, conversationId),
    store: bindings?.storage
      ? createPluginStore(bindings.storage, name, conversation)
      : uninitializedStore(),
    ...(conversationId === undefined
      ? {}
      : {
          conversationId,
          files: makeFileContext(conversationId, bindings),
          case: makeCaseContext(conversationId, bindings),
        }),
    ...(cases === undefined ? {} : { cases }),
  };
}

/**
 * Input authors on hook messages. A user message pi-durable hands to a hook
 * carries no author of its own, so core aligns it with the committed entry that
 * contributed it. Core records the author of every message it hands a hook; a
 * message keeps that author for the next hook only when the hook returns that
 * same object. A `from` a hook writes or changes is ignored, so a plugin cannot
 * relabel input for the plugins after it.
 */
const pristineInputs = new WeakMap<
  readonly Message[],
  Promise<readonly { timestamp?: number; from?: Author }[]>
>();
const pristineToolExternals = new WeakMap<
  readonly Message[],
  Promise<ReadonlyMap<string, boolean> | undefined>
>();
const hookReturned = new WeakSet<Message>();
const keptAuthors = new WeakMap<Message, Author>();
const keptExternals = new WeakMap<Message, true>();
const handedAuthors = new WeakMap<ModelMessage, Author>();

/** Hand a message to a hook, remembering the author core gave it. */
function handed(model: ModelMessage, from: Author | undefined): ModelMessage {
  if (!from) return model;
  const authored = { ...model, from };
  handedAuthors.set(authored, from);
  return authored;
}

/** A message as a hook sees it, with the author of the input that contributed it. */
async function authoredRequestMessages(
  name: string,
  messages: readonly Message[],
  api: HookApi,
  bindings?: PluginBindings,
): Promise<ModelMessage[]> {
  const externals = await toolExternalsOf(name, messages, api, bindings);
  if (messages.some((message) => hookReturned.has(message))) {
    return messages.map((message) => withKeptAuthor(message, externals));
  }
  const inputs = await inputsOf(name, messages, api, bindings);
  const authors = authorsOf(messages, inputs);
  return messages.map((message, index) => {
    const model = reworkMessageFrom(message);
    applyStoredExternal(model, externals);
    return handed(model, model.role === "user" ? authors[index] : undefined);
  });
}

/** Read the committed tool-result external flags once per request. */
function toolExternalsOf(
  name: string,
  messages: readonly Message[],
  api: HookApi,
  bindings?: PluginBindings,
): Promise<ReadonlyMap<string, boolean> | undefined> {
  const cached = pristineToolExternals.get(messages);
  if (cached) return cached;
  const reader = bindings?.toolResultExternals;
  if (!reader) return Promise.resolve(undefined);
  const pending = reader(String(api.conversationId))
    .then(
      (results) => new Map(results.map((result) => [result.toolCallId, result.external] as const)),
    )
    .catch((err) => {
      logHookError(name, "beforeModelRequest", err);
      return new Map<string, boolean>();
    });
  pristineToolExternals.set(messages, pending);
  return pending;
}

/** Re-derive a tool-result message's external flag from the stored result. */
function applyStoredExternal(
  model: ModelMessage,
  externals: ReadonlyMap<string, boolean> | undefined,
): void {
  if (!externals || model.role !== "toolResult" || !model.toolCallId) return;
  if (externals.get(model.toolCallId) === true) model.external = true;
  else delete model.external;
}

/** Read the committed input authors once per request, shared by every plugin. */
function inputsOf(
  name: string,
  messages: readonly Message[],
  api: HookApi,
  bindings?: PluginBindings,
): Promise<readonly { timestamp?: number; from?: Author }[]> {
  const cached = pristineInputs.get(messages);
  if (cached) return cached;
  const reader = bindings?.inputAuthors;
  const pending = reader
    ? reader(String(api.conversationId)).catch((err) => {
        logHookError(name, "beforeModelRequest", err);
        return [];
      })
    : Promise.resolve([]);
  pristineInputs.set(messages, pending);
  return pending;
}

/**
 * Pair each user message with the newest unpaired input entry that shares its
 * timestamp, newest first. A message with no stored match gets no author and
 * leaves the older pairings alone.
 */
export function authorsOf(
  messages: readonly { role: string; timestamp?: number }[],
  inputs: readonly { timestamp?: number; from?: Author }[],
): (Author | undefined)[] {
  const authors: (Author | undefined)[] = messages.map(() => undefined);
  let next = inputs.length - 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" || message.timestamp === undefined) continue;
    let input = next;
    while (input >= 0 && inputs[input]!.timestamp !== message.timestamp) input--;
    if (input < 0) continue;
    authors[index] = inputs[input]!.from;
    next = input - 1;
  }
  return authors;
}

/** The author an entry records, when it carries a well-formed one. */
function entryAuthor(entry: EntryRecord): Author | undefined {
  const data = entry.data as { from?: unknown } | undefined;
  return isAuthor(data?.from) ? data.from : undefined;
}

/**
 * A compaction hook's messages, authored from the entries it summarizes: the
 * entries carry their own author, so no read is needed.
 */
function authoredCompactionMessages(
  entries: readonly EntryRecord[],
  messages: readonly Message[],
): ModelMessage[] {
  const inputs: { timestamp?: number; from?: Author }[] = [];
  for (const entry of entries) {
    const from = entryAuthor(entry);
    for (const message of entry.model ?? []) {
      if (message.role === "user") inputs.push({ timestamp: message.timestamp, from });
    }
  }
  const authors = authorsOf(messages, inputs);
  return messages.map((message, index) => {
    const model = reworkMessageFrom(message);
    return handed(model, model.role === "user" ? authors[index] : undefined);
  });
}

/**
 * A message a hook returned. It keeps the author core handed it with only when
 * the hook returned that same object; any `from` the hook wrote is ignored.
 */
function hookMessageTo(message: ModelMessage): Message {
  const converted = reworkMessageTo(message);
  hookReturned.add(converted);
  const from = message.role === "user" ? handedAuthors.get(message) : undefined;
  if (from) keptAuthors.set(converted, from);
  if (message.role === "toolResult" && message.external === true)
    keptExternals.set(converted, true);
  return converted;
}

function withKeptAuthor(
  message: Message,
  externals: ReadonlyMap<string, boolean> | undefined,
): ModelMessage {
  const model = reworkMessageFrom(message);
  applyStoredExternal(model, externals);
  if (model.role === "toolResult" && keptExternals.get(message) === true) model.external = true;
  return handed(model, model.role === "user" ? keptAuthors.get(message) : undefined);
}

function reworkMessageFrom(message: Message): ModelMessage {
  const role = message.role;
  const content = message.content;
  if (role === "toolResult") {
    const m: ModelMessage = {
      role: "toolResult",
      content: blocksToText(content as readonly { type: string; text?: string }[]),
    };
    if (message.toolCallId) m.toolCallId = message.toolCallId;
    if (message.toolName) m.toolName = message.toolName;
    if (message.timestamp !== undefined) m.timestamp = message.timestamp;
    if (message.isError === true) m.isError = true;
    if (externalOfDetails((message as { details?: JsonValue }).details)) m.external = true;
    return m;
  }
  if (typeof content === "string") {
    return { role, content };
  }
  if (Array.isArray(content)) {
    const blocks: ModelMessage["content"] = content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text } as const;
      if (block.type === "image") {
        return { type: "image", data: block.data, mimeType: block.mimeType } as const;
      }
      if (block.type === "toolCall") {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          args: block.arguments,
        } as const;
      }
      return { type: "other", raw: block } as const;
    });
    return { role, content: blocks };
  }
  return { role, content: "" };
}

function reworkMessageTo(message: ModelMessage): Message {
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId ?? "",
      toolName: message.toolName ?? "",
      content: [{ type: "text", text: textOf(message.content) }],
      isError: message.isError === true,
      timestamp: message.timestamp ?? 0,
    } as unknown as Message;
  }
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content } as Message;
  }
  const blocks = message.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image")
      return { type: "image", data: block.data, mimeType: block.mimeType };
    if (block.type === "toolCall") {
      return { type: "toolCall", id: block.id, name: block.name, arguments: block.args };
    }
    return block.raw;
  });
  return { role: message.role, content: blocks } as Message;
}

function blocksToText(content: readonly { type: string; text?: string }[]): string {
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return blocksToText(content);
}

function messageText(message: AssistantMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  return "";
}

function usageOf(message: AssistantMessage): ModelUsage | undefined {
  const usage = (message as { usage?: Usage }).usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function logHookError(plugin: string, hook: string, err: unknown): void {
  console.error(`[reework] plugin "${plugin}" ${hook} hook threw:`, err);
}

function durableResultToRework(result: ToolExecutionResult): ToolResult {
  const output =
    typeof result.output === "string"
      ? result.output
      : Array.isArray(result.output)
        ? result.output.map((b) => (b.type === "text" ? b.text : "")).join("")
        : "";
  return {
    output,
    ...(result.isError === true ? { isError: true } : {}),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(externalOfDetails(result.details) ? { external: true } : {}),
  } as ToolResult;
}
