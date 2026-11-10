import { readFileSync } from "node:fs";
import type {
  AgentDefinition,
  AgentModel,
  SecretDefinition,
  SecretsBackend,
} from "../agent-definition.ts";
import type { SecretUseEvent } from "../tooling/facade.ts";

/**
 * The agent's secrets: definitions are validated before the engine opens, and
 * values are resolved only when something needs them. The local backend reads
 * the source itself; later tasks add the plugin surface and the gateway backend.
 */
export class SecretsRuntime {
  private readonly definitions: Record<string, SecretDefinition>;
  private readonly modelKeySecrets: ReadonlySet<string>;
  private readonly backend: SecretsBackend;
  private declarations = new Map<string, readonly string[]>();
  private onUse?: (event: SecretUseEvent) => void;

  constructor(
    definitions: Record<string, SecretDefinition>,
    modelKeySecrets: ReadonlySet<string> = new Set(),
    backend: SecretsBackend = { kind: "local" },
  ) {
    this.definitions = definitions;
    this.modelKeySecrets = modelKeySecrets;
    this.backend = backend;
  }

  /** Whether values live at a gateway rather than in this process. */
  isGateway(): boolean {
    return this.backend.kind === "gateway";
  }

  /** The gateway URL for one of its routes, without a trailing slash. */
  gatewayUrl(path: string): string {
    if (this.backend.kind !== "gateway") throw new Error("secrets backend is not a gateway");
    return `${this.backend.url.replace(/\/$/, "")}${path}`;
  }

  /** The box token the gateway backend authenticates with. */
  gatewayToken(): string {
    if (this.backend.kind !== "gateway") throw new Error("secrets backend is not a gateway");
    const token = process.env[this.backend.tokenEnv];
    if (!token)
      throw new Error(`secret gateway token variable ${this.backend.tokenEnv} is not set`);
    return token;
  }

  /** The provider base URL for a gateway upstream (the provider appends its path). */
  gatewayBaseUrl(upstream: string): string {
    return this.gatewayUrl(`/plugins/secrets-gateway/open/llm/${encodeURIComponent(upstream)}`);
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

  /** Where secret uses are reported (the agent's event queue). */
  setOnUse(onUse: (event: SecretUseEvent) => void): void {
    this.onUse = onUse;
  }

  private audit(
    plugin: string,
    name: string,
    kind: "get" | "fetch",
    conversationId?: string,
  ): void {
    this.onUse?.({
      plugin,
      name,
      kind,
      at: Date.now(),
      ...(conversationId ? { conversationId } : {}),
    });
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
      if (
        apply &&
        !this.modelKeySecrets.has(name) &&
        (!definition.hosts || definition.hosts.length === 0)
      ) {
        throw new Error(`secret "${name}": hosts is required for a fetchable secret`);
      }
      if (this.backend.kind === "gateway") continue;
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

  /** Fail startup when the gateway backend's token variable is unset. */
  validateGatewayToken(): void {
    if (this.backend.kind === "gateway" && !process.env[this.backend.tokenEnv]) {
      throw new Error(`secret gateway token variable ${this.backend.tokenEnv} is not set`);
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
    conversationId?: string,
  ): Promise<Response> {
    this.requireDeclared(plugin, name);
    const definition = this.definitions[name];
    if (!definition) throw new Error(`secret "${name}" is not declared`);
    if (this.backend.kind === "gateway") {
      const headers = new Headers(init.headers);
      const targetHeaders: Record<string, string> = {};
      for (const [key, value] of headers) targetHeaders[key] = value;
      this.audit(plugin, name, "fetch", conversationId);
      return fetch(this.gatewayUrl("/plugins/secrets-gateway/open/proxy"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.gatewayToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          secret: name,
          url,
          method: init.method ?? "GET",
          headers: targetHeaders,
          ...(typeof init.body === "string" ? { body: init.body } : {}),
        }),
      });
    }
    const value = this.resolve(name);
    const allowed = definition.hosts ?? [];
    const headers = new Headers(init.headers);
    if (!definition.apply) throw new Error(`secret "${name}" has no apply rule`);
    let method = init.method ?? "GET";
    let body = init.body;
    let target = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = target.hostname;
      if (!allowed.some((entry) => entry.toLowerCase() === host.toLowerCase())) {
        throw new Error(`secret "${name}" may not be sent to host "${host}"`);
      }
      const request = new URL(target);
      if ("header" in definition.apply) {
        const format = definition.apply.format ?? "{}";
        headers.set(definition.apply.header, format.replace("{}", value));
      } else {
        request.searchParams.set(definition.apply.query, value);
      }
      const response = await fetch(request, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        this.audit(plugin, name, "fetch", conversationId);
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        this.audit(plugin, name, "fetch", conversationId);
        return response;
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`secret "${name}" redirect limit exceeded at host "${host}"`);
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method !== "GET" &&
          method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
      }
      target = new URL(location, request);
    }
    throw new Error(`secret "${name}" redirect limit exceeded`);
  }

  /** The raw value of a declared secret (local backend). */
  async get(plugin: string, name: string, conversationId?: string): Promise<string> {
    this.requireDeclared(plugin, name);
    if (this.backend.kind === "gateway") {
      const response = await fetch(this.gatewayUrl("/plugins/secrets-gateway/open/raw"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.gatewayToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ secret: name }),
      });
      if (!response.ok) {
        throw new Error(`secret "${name}" raw access refused (${response.status})`);
      }
      const body = (await response.json()) as { value?: unknown };
      if (typeof body.value !== "string") {
        throw new Error(`secret "${name}" raw access returned no value`);
      }
      this.audit(plugin, name, "get", conversationId);
      return body.value;
    }
    const value = this.resolve(name);
    this.audit(plugin, name, "get", conversationId);
    return value;
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

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
