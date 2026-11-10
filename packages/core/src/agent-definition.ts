/**
 * The agent-definition contract. A single declarative object describing an
 * agent: name, model (custom provider endpoint), plugins, channels, and the
 * mission (role + tools). It is config, not business logic.
 */
import type { Hono } from "hono";
import type { AgentHost } from "./host.ts";
import type { ReeworkPlugin } from "./tooling/facade.ts";
import type { RunLimits } from "./runtime/budget.ts";

export type { RunLimits };

export type AgentModelApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface AgentModelProvider {
  /**
   * Base URL of the model endpoint, as its protocol's SDK expects it: OpenAI-style
   * endpoints include the version (`https://host/v1`); Anthropic-style endpoints
   * do not (`https://host` — the SDK appends `/v1/messages`).
   */
  baseUrl: string;
  /** Name of the environment variable holding the API key; checked at startup. */
  apiKeyEnv?: string;
  /** A declared secret holding the API key, instead of `apiKeyEnv`. */
  apiKey?: { readonly secret: string };
  /** Wire protocol of the endpoint. Default: `openai-completions`. */
  api?: AgentModelApi;
}

export interface AgentModel {
  provider: AgentModelProvider;
  modelId: string;
  /** Context window in tokens; compaction keeps conversations within it. Default 128000. */
  contextWindow?: number;
  /** Output-token cap sent with every request. Default 8192; must be below `contextWindow`. */
  maxTokens?: number;
  /**
   * Most requests in flight to the endpoint at once, across every conversation; further
   * requests wait for a slot (the wait does not count against stream timeouts). Default
   * unlimited.
   */
  maxConcurrentRequests?: number;
  /**
   * For named models only: the input modalities this model accepts. Default
   * `["text"]`; add `"image"` for a vision model. The conversation model stays
   * text-only.
   */
  input?: readonly ("text" | "image")[];
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

/** A case field the `update_case` tool may write. */
export type CaseToolField =
  | "title"
  | "summary"
  | "stage"
  | "priority"
  | "tags"
  | "dueAt"
  | "status";

/** How the model may write a case. */
export interface AgentCasesConfig {
  /**
   * The `update_case` model tool. `false` turns it off (the model is not offered
   * it). Omitted, it is offered with every case field; `{ fields }` narrows the
   * fields it may write and that appear in its schema.
   */
  modelTool?: false | { readonly fields?: readonly CaseToolField[] };
}

export interface SecretDefinition {
  /** Where the value comes from: `env:VAR` or `file:/path`. */
  from: string;
  /** How the value is applied to a request: a header or a query parameter. */
  apply?: { readonly header: string; readonly format?: string } | { readonly query: string };
  /** Hosts the secret may be sent to; required for a fetchable secret. */
  hosts?: readonly string[];
}

export interface AgentDefinition {
  name: string;
  model: AgentModel;
  /** Named secrets and how they are applied; validated at startup. */
  secrets?: Record<string, SecretDefinition>;
  /** How the model may write a case. */
  cases?: AgentCasesConfig;
  /** Named models a plugin may call, keyed by name. `main` is reserved. */
  models?: Record<string, AgentModel>;
  /** Bounds on files. Default max size: 10 MiB. */
  files?: { readonly maxBytes?: number };
  plugins: DeclaredModule[];
  channels: DeclaredModule[];
  mission: AgentMission;
  /** Bounds on one run (the work answering an input). */
  limits?: RunLimits;
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
