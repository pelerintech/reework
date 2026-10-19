/**
 * The agent-definition contract. A single declarative object describing an
 * agent: name, model (custom provider endpoint), plugins, channels, and the
 * mission (role + tools). It is config, not business logic.
 */

export interface AgentModelProvider {
  baseUrl: string;
  apiKey: string;
}

export interface AgentModel {
  provider: AgentModelProvider;
  modelId: string;
}

/** A declared plugin or channel: an installed package with per-item config. */
export interface DeclaredModule<TConfig = Record<string, unknown>> {
  plugin: unknown;
  config: TConfig;
}

export interface AgentMission {
  /** The agent's role/persona. */
  role: string;
  /** The capabilities/tool names the agent can invoke. */
  tools: string[];
}

export interface AgentDefinition {
  name: string;
  model: AgentModel;
  plugins: DeclaredModule[];
  channels: DeclaredModule[];
  mission: AgentMission;
}

/** Define an agent declaratively. Returns the typed definition object. */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
