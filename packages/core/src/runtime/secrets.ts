import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentModel, SecretDefinition } from "../agent-definition.ts";

/**
 * The agent's secrets: definitions are validated before the engine opens, and
 * values are resolved only when something needs them. The local backend reads
 * the source itself; later tasks add the plugin surface and the gateway backend.
 */
export class SecretsRuntime {
  private readonly definitions: Record<string, SecretDefinition>;
  private readonly modelKeySecrets: ReadonlySet<string>;
  private declarations = new Map<string, readonly string[]>();

  constructor(
    definitions: Record<string, SecretDefinition>,
    modelKeySecrets: ReadonlySet<string> = new Set(),
  ) {
    this.definitions = definitions;
    this.modelKeySecrets = modelKeySecrets;
  }

  /** Record which secrets each built plugin declared. */
  setDeclarations(declarations: ReadonlyMap<string, readonly string[]>): void {
    this.declarations = new Map(declarations);
  }

  private requireDeclared(plugin: string, name: string): void {
    const declared = this.declarations.get(plugin) ?? [];
    if (!declared.includes(name)) {
      throw new Error(`plugin "${plugin}" did not declare secret "${name}"`);
    }
  }

  /** Fail startup for a malformed definition or a missing local source. */
  validate(): void {
    for (const [name, definition] of Object.entries(this.definitions)) {
      const from = definition.from;
      const env = from.startsWith("env:") && from.length > "env:".length;
      const file = from.startsWith("file:") && from.length > "file:".length;
      if (!env && !file) {
        throw new Error(
          `secret "${name}": unknown from form "${from}" (expected env:VAR or file:/path)`,
        );
      }
      const apply = definition.apply;
      if (apply && "header" in apply && "query" in apply) {
        throw new Error(`secret "${name}": apply must set exactly one of header or query`);
      }
      if (!this.modelKeySecrets.has(name) && (!definition.hosts || definition.hosts.length === 0)) {
        throw new Error(`secret "${name}": hosts is required for a fetchable secret`);
      }
      if (env) {
        const variable = definition.from.slice("env:".length);
        if (!process.env[variable]) {
          throw new Error(`secret "${name}" environment variable ${variable} is not set`);
        }
      } else if (file) {
        const path = from.slice("file:".length);
        try {
          readFileSync(path, "utf8");
        } catch {
          throw new Error(`secret "${name}" file ${path} could not be read`);
        }
      }
    }
  }

  /** The raw value of a declared secret (local backend). */
  resolve(name: string): string {
    const definition = this.definitions[name];
    if (!definition) throw new Error(`secret "${name}" is not declared`);
    if (definition.from.startsWith("env:")) {
      const variable = definition.from.slice("env:".length);
      const value = process.env[variable];
      if (value === undefined) {
        throw new Error(`secret "${name}" environment variable ${variable} is not set`);
      }
      return value;
    }
    if (definition.from.startsWith("file:")) {
      const path = definition.from.slice("file:".length);
      try {
        return readFileSync(path, "utf8").trim();
      } catch {
        throw new Error(`secret "${name}" file ${path} could not be read`);
      }
    }
    throw new Error(`secret "${name}" cannot be resolved from "${definition.from}"`);
  }

  /** Send a request with a declared secret applied; the value is never returned. */
  async fetch(
    plugin: string,
    name: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    this.requireDeclared(plugin, name);
    const definition = this.definitions[name];
    if (!definition) throw new Error(`secret "${name}" is not declared`);
    const value = this.resolve(name);
    const target = new URL(url);
    const allowed = definition.hosts ?? [];
    if (!allowed.some((host) => host.toLowerCase() === target.hostname.toLowerCase())) {
      throw new Error(`secret "${name}" may not be sent to host "${target.hostname}"`);
    }
    const headers = new Headers(init.headers);
    if (!definition.apply) throw new Error(`secret "${name}" has no apply rule`);
    if ("header" in definition.apply) {
      const format = definition.apply.format ?? "{}";
      headers.set(definition.apply.header, format.replace("{}", value));
    } else {
      target.searchParams.set(definition.apply.query, value);
    }
    return fetch(target, { ...init, headers });
  }

  /** The raw value of a declared secret (local backend). */
  async get(plugin: string, name: string): Promise<string> {
    this.requireDeclared(plugin, name);
    return this.resolve(name);
  }
}

/** The secret names a model provider uses as its API key. */
export function modelSecretNames(agent: AgentDefinition): Set<string> {
  const names = new Set<string>();
  const collect = (model: AgentModel | undefined) => {
    const secret = model?.provider.apiKey?.secret;
    if (secret) names.add(secret);
  };
  collect(agent.model);
  for (const model of Object.values(agent.models ?? {})) collect(model);
  return names;
}

export interface SecretsAccess {
  fetch(
    plugin: string,
    name: string,
    url: string,
    init?: RequestInit,
    conversationId?: string,
  ): Promise<Response>;
  get(plugin: string, name: string, conversationId?: string): Promise<string>;
}
