import {
  CompactionTask,
  defineExtension,
  defineTool as durableDefineTool,
  GenerationTask,
  hook,
  section as durableSection,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  Extension,
  EntryRecord,
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
} from "@reework/types";
import { isAuthor } from "@reework/types";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { AgentHost } from "../host.ts";
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

/** The named models a plugin declared, keyed by name. */
export interface PluginModels {
  complete(name: string, input: ModelCompleteInput): Promise<ModelCompleteResult>;
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
  /** Files scoped to this conversation. */
  readonly files: CaseFiles;
  /** This plugin's storage, agent-wide and per case. */
  readonly store: PluginStore;
  /** The conversation's case. */
  readonly case: CaseContext;
  /** Run `fn` at most once per tool call and key; a replay returns the value. */
  once<T extends JsonValue>(key: string, fn: () => Promise<T>): Promise<T>;
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
  /** This plugin's storage, agent-wide and per case. */
  readonly store: PluginStore;
  /** Files scoped to this conversation. */
  readonly files: CaseFiles;
  /** The conversation's case. */
  readonly case: CaseContext;
  /** A value computed once per task attempt and reused on retry. */
  memo<T extends JsonValue>(name: string, compute: () => Promise<T>): Promise<T>;
}

/** The context an event hook receives: a run hook's bindings without `memo`. */
export interface PluginEventContext {
  readonly conversationId: string;
  /** The named models this plugin declared. */
  readonly models: PluginModels;
  /** This plugin's storage, agent-wide and per case. */
  readonly store: PluginStore;
  /** Files scoped to this conversation. */
  readonly files: CaseFiles;
  /** The conversation's case. */
  readonly case: CaseContext;
}

/** The hooks a plugin may provide, run in plugin declaration order. */
export interface PluginHooks {
  beforeModelRequest?(
    input: { messages: ModelMessage[] },
    ctx: PluginHookContext,
  ): Promise<{ messages: ModelMessage[] } | void>;
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
  onAnswer?(input: { text: string }, ctx: PluginHookContext): Promise<{ continue: string } | void>;
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
}

// ---------------------------------------------------------------------------
// Plugin / built plugin / extension.
// ---------------------------------------------------------------------------

/** What a plugin's `setup` receives once the engine is open. */
export interface PluginSetupContext<TConfig> {
  readonly host: AgentHost;
  readonly store: PluginStore;
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
}

/** What a plugin's `routes(app, ctx)` receives. */
export interface PluginRouteContext<TConfig> {
  readonly host: AgentHost;
  readonly store: PluginStore;
  readonly config: TConfig;
  /** Aborted when the agent begins to stop. */
  readonly signal: AbortSignal;
  /** This plugin's directory beside the agent's storage. */
  readonly dataDir: string;
  /** The named models this plugin declared, for a route handler's own work. */
  readonly models: PluginModels;
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
}

export function definePlugin<
  TConfig = unknown,
  TReturn extends BuiltPlugin<TConfig> | Promise<BuiltPlugin<TConfig>> = BuiltPlugin<TConfig>,
>(
  name: string,
  factory: (config: TConfig) => TReturn,
  options: { readonly models?: readonly string[] } = {},
): {
  readonly kind: "reework.plugin";
  readonly name: string;
  readonly models: readonly string[];
  /** The factory's own return type: a built plugin, or a promise of one. */
  build(config: TConfig): TReturn;
} {
  return { kind: "reework.plugin", name, build: factory, models: options.models ?? [] };
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
      return toDurableResult(result, modelCalls);
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
  const made: ToolContext = {
    conversationId: String(api.conversationId),
    signal,
    output: (chunk) => api.output(chunk),
    store: createPluginStore(backend, pluginName, api.conversationId),
    models: makePluginModels(pluginName, bindings, (call) => modelCalls.push(call)),
    files: makeFileContext(String(api.conversationId), bindings),
    case: makeCaseContext(String(api.conversationId), bindings),
    once: (key, fn) => once(api, key, context, fn),
  };
  (made as unknown as { [TOOL_INTERNAL]: ToolInternal })[TOOL_INTERNAL] = { api, context };
  return { ctx: made, modelCalls };
}

/** Convert a reework tool result to the pi-durable execution result. */
function toDurableResult(
  result: string | ToolResult,
  modelCalls: readonly NamedModelCall[] = [],
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
    ...(typeof result !== "string" && result.external === true ? { external: true } : {}),
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
): Pick<ToolContext, "models" | "files" | "store" | "case"> {
  return {
    models: makePluginModels(pluginName, bindings, collect),
    files: conversationId ? makeFileContext(conversationId, bindings) : stubFiles(),
    store: store ?? uninitializedStore(),
    case: conversationId ? makeCaseContext(conversationId, bindings) : stubCase(),
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
  readonly lent: ReadonlyMap<string, readonly string[]>;
  case?: PluginCaseAccess;
  files?: PluginFilesAccess;
  /**
   * The committed model context's user messages, oldest first, each with the
   * author of the entry that contributed it, so hooks can name an input's
   * author. Filled once the engine exists.
   */
  inputAuthors?: (
    conversationId: string,
  ) => Promise<readonly { timestamp?: number; from?: Author }[]>;
  /** The engine's storage, for the plugin store run hooks get. Filled once the engine exists. */
  storage?: StoreBackend;
}

export function makePluginModels(
  pluginName: string,
  bindings?: PluginBindings,
  collect?: (call: NamedModelCall) => void,
): PluginModels {
  const lent = bindings?.lent.get(pluginName) ?? [];
  return {
    complete: async (name, input) => {
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
      if (hasImage(input.messages) && !(model.input as readonly string[]).includes("image")) {
        throw new Error(`model "${name}" does not accept image input`);
      }
      const result = await catalog.complete(
        model,
        { systemPrompt: input.system, messages: toAiMessages(input.messages) },
        { signal: input.signal },
      );
      if (result.usage) collect?.({ model: name, usage: result.usage });
      return { text: assistantText(result), usage: mapUsage(result.usage) };
    },
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

  if (hooks.beforeModelRequest || hooks.afterModelResponse || hooks.onAnswer) {
    registration.push(
      hook(GenerationTask, {
        beforeRequest({ messages }, api, context) {
          const run = async () => {
            if (!hooks.beforeModelRequest) return undefined;
            const next = await hooks.beforeModelRequest(
              { messages: await authoredRequestMessages(name, messages, api, bindings) },
              hookCtx(api, context),
            );
            if (!next?.messages) return undefined;
            return { messages: next.messages.map(hookMessageTo) };
          };
          return run().catch((err) => {
            logHookError(name, "beforeModelRequest", err);
            return undefined;
          });
        },
        afterResponse(message, api, context) {
          if (!hooks.afterModelResponse) return undefined;
          return Promise.resolve(
            hooks.afterModelResponse(
              {
                message: reworkMessageFrom(message as unknown as Message),
                usage: usageOf(message),
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
            const next = await hooks.onAnswer!(
              { text: messageText(answer) },
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
): PluginHookContext {
  return {
    conversationId: String(api.conversationId),
    ...createPluginContextMembers(
      bindings?.storage ? createPluginStore(bindings.storage, name, api.conversationId) : undefined,
      undefined,
      bindings,
    ),
    models: makePluginModels(name, bindings),
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
          makeHookContext(p.name, api, context, bindings),
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
                makeHookContext(q.name, api, context, bindings),
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
          makeHookContext(p.name, api, context, bindings),
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
const hookReturned = new WeakSet<Message>();
const keptAuthors = new WeakMap<Message, Author>();
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
  if (messages.some((message) => hookReturned.has(message))) {
    return messages.map((message) => withKeptAuthor(message));
  }
  const inputs = await inputsOf(name, messages, api, bindings);
  const authors = authorsOf(messages, inputs);
  return messages.map((message, index) => {
    const model = reworkMessageFrom(message);
    return handed(model, model.role === "user" ? authors[index] : undefined);
  });
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
  return converted;
}

function withKeptAuthor(message: Message): ModelMessage {
  const model = reworkMessageFrom(message);
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
