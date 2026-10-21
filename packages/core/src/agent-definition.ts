/**
 * The agent-definition contract. A single declarative object describing an
 * agent: name, model (custom provider endpoint), plugins, channels, and the
 * mission (role + tools). It is config, not business logic.
 */
import type { Hono } from "hono";
import type { AgentHost } from "./host.ts";
import type { ReeworkPlugin } from "./tooling/facade.ts";

export type AgentModelApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface AgentModelProvider {
  /**
   * Base URL of the model endpoint, as its protocol's SDK expects it: OpenAI-style
   * endpoints include the version (`https://host/v1`); Anthropic-style endpoints
   * do not (`https://host` — the SDK appends `/v1/messages`).
   */
  baseUrl: string;
  /** Name of the environment variable holding the API key; checked at startup. */
  apiKeyEnv: string;
  /** Wire protocol of the endpoint. Default: `openai-completions`. */
  api?: AgentModelApi;
}

export interface AgentModel {
  provider: AgentModelProvider;
  modelId: string;
}

/** A declared plugin or channel: a plugin factory with the config it is built from. */
export interface DeclaredModule<TConfig = any> {
  plugin: ReeworkPlugin<TConfig>;
  config: TConfig;
}

export interface AgentMission {
  /** The agent's role/persona; becomes its instructions. */
  role: string;
  /** Tool names the model may call; omitted means every installed tool. */
  tools?: string[];
}

export interface AgentDefinition {
  name: string;
  model: AgentModel;
  plugins: DeclaredModule[];
  channels: DeclaredModule[];
  mission: AgentMission;
  /**
   * Mount custom routes (e.g. a webhook) next to the built-in protocol. They get
   * the in-process host and are NOT behind the API token: authenticate them
   * yourself. Avoid the `/conversations` and `/proposals` prefixes.
   */
  routes?: (app: Hono, host: AgentHost) => void;
}

/** Define an agent declaratively. Returns the typed definition object. */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
