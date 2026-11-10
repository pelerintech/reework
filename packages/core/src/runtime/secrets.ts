import { readFileSync } from "node:fs";
import type { SecretDefinition } from "../agent-definition.ts";

/**
 * The agent's secrets: definitions are validated before the engine opens, and
 * values are resolved only when something needs them. The local backend reads
 * the source itself; later tasks add the plugin surface and the gateway backend.
 */
export class SecretsRuntime {
  private readonly definitions: Record<string, SecretDefinition>;

  constructor(definitions: Record<string, SecretDefinition>) {
    this.definitions = definitions;
  }

  /** Fail startup for a declared secret whose local source is missing. */
  validate(): void {
    for (const [name, definition] of Object.entries(this.definitions)) {
      if (definition.from.startsWith("env:")) {
        const variable = definition.from.slice("env:".length);
        if (!process.env[variable]) {
          throw new Error(`secret "${name}" environment variable ${variable} is not set`);
        }
      } else if (definition.from.startsWith("file:")) {
        const path = definition.from.slice("file:".length);
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
    _plugin: string,
    name: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const definition = this.definitions[name];
    if (!definition) throw new Error(`secret "${name}" is not declared`);
    const value = this.resolve(name);
    const target = new URL(url);
    const headers = new Headers(init.headers);
    if (definition.apply && "header" in definition.apply) {
      const format = definition.apply.format ?? "{}";
      headers.set(definition.apply.header, format.replace("{}", value));
    }
    return fetch(target, { ...init, headers });
  }

  /** The raw value of a declared secret (local backend). */
  get(_plugin: string, name: string): Promise<string> {
    return Promise.resolve(this.resolve(name));
  }
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
