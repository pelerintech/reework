import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type {
  AnyTask,
  Extension,
  PromptSection,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { AgentHost } from "../host.ts";
import type { StorageSeam } from "./storage.ts";

/**
 * The plugin facade. This is the single point that touches pi-durable's
 * extension API. Plugins import only `@reework/core`, so a pi-durable API change
 * is contained here and the plugins keep working without modification.
 */

/** Re-export the tool/section builders so plugins need not import pi-durable. */
export { defineTool, section };

/** The schema builder for tool parameters, so plugins need not import pi-ai. */
export { Type } from "@earendil-works/pi-ai";
export type { Static, TSchema } from "@earendil-works/pi-ai";

/**
 * pi-durable's coding tools (read, write, edit, bash), unchanged. They act in the
 * conversation's workspace `cwd`; relative paths resolve there, but nothing
 * confines absolute or `../` paths — wrap them if you need a hard boundary.
 */
export {
  CodingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

/** The conversation a workspace is prepared for. */
export interface WorkspaceTarget {
  readonly conversationId: string;
  readonly key?: string;
}

/** Prepares a working directory for each new conversation (a clone, a worktree, a temp dir). */
export interface WorkspaceProvider {
  create(conversation: WorkspaceTarget): Promise<{ cwd: string }>;
}

/** What a plugin's `setup` receives once the engine is open. */
export interface PluginSetupContext<TConfig> {
  readonly host: AgentHost;
  readonly storage: StorageSeam;
  readonly config: TConfig;
}

/** What a plugin factory returns for one config. */
export interface BuiltPlugin<TConfig = unknown> {
  readonly tools?: readonly ToolRegistration[];
  readonly sections?: readonly PromptSection[];
  readonly tasks?: readonly AnyTask[];
  /** Runtime wiring after the engine opens (watchers, channel transports). */
  setup?(ctx: PluginSetupContext<TConfig>): void | Promise<void>;
  /** At most one plugin per agent may provide each conversation's workspace. */
  readonly workspace?: WorkspaceProvider;
}

/** A plugin: a factory from its config to the tools, sections and tasks it adds. */
export interface ReeworkPlugin<TConfig = unknown> {
  readonly kind: "reework.plugin";
  /** Unique plugin name; also the name of its pi-durable extension. */
  readonly name: string;
  build(config: TConfig): BuiltPlugin<TConfig>;
}

export function definePlugin<TConfig = unknown>(
  name: string,
  factory: (config: TConfig) => BuiltPlugin<TConfig>,
): ReeworkPlugin<TConfig> {
  return { kind: "reework.plugin", name, build: factory };
}

export function isReeworkPlugin(value: unknown): value is ReeworkPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "reework.plugin"
  );
}

/** Turn a built plugin into the pi-durable extension the registry installs. */
export function toExtension(name: string, built: BuiltPlugin): Extension {
  return defineExtension({
    name,
    tools: built.tools ?? [],
    sections: built.sections ?? [],
    tasks: built.tasks ?? [],
  });
}
