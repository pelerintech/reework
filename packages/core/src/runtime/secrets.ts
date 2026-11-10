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
      if (!definition.from.startsWith("env:")) continue;
      const variable = definition.from.slice("env:".length);
      if (!process.env[variable]) {
        throw new Error(`secret "${name}" environment variable ${variable} is not set`);
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
    throw new Error(`secret "${name}" cannot be resolved from "${definition.from}"`);
  }
}
