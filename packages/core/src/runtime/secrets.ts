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
  private pendingUses: SecretUseEvent[] = [];

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

  /** The gateway request timeout: configured, or 30 seconds. */
  private gatewayTimeout(): number {
    return this.backend.kind === "gateway" ? (this.backend.timeoutMs ?? 30_000) : 30_000;
  }

  /** A signal that honours the caller's abort and the gateway timeout. */
  private gatewaySignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.gatewayTimeout());
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /** Encode a request body for the gateway protocol: string or base64 bytes. */
  private async gatewayBody(
    name: string,
    body: RequestInit["body"],
  ): Promise<{ body?: string; bodyBase64?: string }> {
    if (body === undefined || body === null) return {};
    if (typeof body === "string") return { body };
    if (body instanceof URLSearchParams) return { body: body.toString() };
    if (body instanceof Uint8Array) return { bodyBase64: Buffer.from(body).toString("base64") };
    if (body instanceof ArrayBuffer) return { bodyBase64: Buffer.from(body).toString("base64") };
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return { bodyBase64: Buffer.from(await body.arrayBuffer()).toString("base64") };
    }
    if (ArrayBuffer.isView(body)) {
      return {
        bodyBase64: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64"),
      };
    }
    throw new Error(`secret "${name}" gateway request body type is unsupported`);
  }

  /** Record which secrets each built plugin declared. */
  setDeclarations(declarations: ReadonlyMap<string, readonly string[]>): void {
    this.declarations = new Map(declarations);
  }

  private requireDeclared(
    plugin: string,
    name: string,
    kind: "get" | "fetch",
    conversationId?: string,
  ): void {
    const declared = this.declarations.get(plugin) ?? [];
    if (!declared.includes(name)) {
      this.audit(plugin, name, kind, "refused", conversationId);
      throw new Error(`plugin "${plugin}" did not declare secret "${name}"`);
    }
  }

  /** Where secret uses are reported (the agent's event queue). */
  setOnUse(onUse: (event: SecretUseEvent) => void): void {
    this.onUse = onUse;
    for (const event of this.pendingUses.splice(0)) onUse(event);
  }

  private audit(
    plugin: string,
    name: string,
    kind: "get" | "fetch" | "model",
    outcome: "used" | "refused",
    conversationId?: string,
  ): void {
    const event: SecretUseEvent = {
      plugin,
      name,
      kind,
      outcome,
      at: Date.now(),
      ...(conversationId ? { conversationId } : {}),
    };
    if (!this.onUse) this.pendingUses.push(event);
    else this.onUse(event);
  }

  /** Resolve a model's API key secret once at startup and report its use. */
  modelKey(label: string, name: string): string {
    const value = this.resolve(name);
    this.audit(label, name, "model", "used");
    return value;
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
      if (apply !== undefined) {
        const hasHeaderField = "header" in apply;
        const hasQueryField = "query" in apply;
        const header = hasHeaderField ? (apply as { header?: unknown }).header : undefined;
        const query = hasQueryField ? (apply as { query?: unknown }).query : undefined;
        const headerOk = typeof header === "string" && header.length > 0;
        const queryOk = typeof query === "string" && query.length > 0;
        if (hasHeaderField === hasQueryField || !(headerOk || queryOk)) {
          throw new Error(
            `secret "${name}": apply must set exactly one of header or query (non-empty)`,
          );
        }
        const format = (apply as { format?: unknown }).format;
        if (format !== undefined && typeof format !== "string") {
          throw new Error(`secret "${name}": apply.format must be a string`);
        }
      }
      const hosts = definition.hosts;
      if (hosts !== undefined) {
        if (!Array.isArray(hosts)) {
          throw new Error(`secret "${name}": hosts must be an array of host strings`);
        }
        if (hosts.some((host) => typeof host !== "string")) {
          throw new Error(`secret "${name}": hosts must be an array of host strings`);
        }
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
        const value = process.env[variable];
        if (value === undefined) {
          throw new Error(`secret "${name}" environment variable ${variable} is not set`);
        }
        if (value.trim() === "") {
          throw new Error(`secret "${name}" resolved value is empty`);
        }
      } else if (file) {
        const path = from.slice("file:".length);
        let value: string;
        try {
          value = readFileSync(path, "utf8");
        } catch {
          throw new Error(`secret "${name}" file ${path} could not be read`);
        }
        if (value.trim() === "") {
          throw new Error(`secret "${name}" resolved value is empty`);
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
      if (value.trim() === "") {
        throw new Error(`secret "${name}" resolved value is empty`);
      }
      return value;
    }
    if (definition.from.startsWith("file:")) {
      const path = definition.from.slice("file:".length);
      let value: string;
      try {
        value = readFileSync(path, "utf8").trim();
      } catch {
        throw new Error(`secret "${name}" file ${path} could not be read`);
      }
      if (value === "") {
        throw new Error(`secret "${name}" resolved value is empty`);
      }
      return value;
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
    this.requireDeclared(plugin, name, "fetch", conversationId);
    const definition = this.definitions[name];
    if (!definition) {
      this.audit(plugin, name, "fetch", "refused", conversationId);
      throw new Error(`secret "${name}" is not declared`);
    }
    if (this.backend.kind === "gateway") {
      const headers = new Headers(init.headers);
      const targetHeaders: Record<string, string> = {};
      for (const [key, value] of headers) targetHeaders[key] = value;
      let payload: { body?: string; bodyBase64?: string };
      try {
        payload = await this.gatewayBody(name, init.body);
      } catch (error) {
        this.audit(plugin, name, "fetch", "refused", conversationId);
        throw new Error(`secret "${name}" gateway request failed: ${messageOf(error)}`, {
          cause: error,
        });
      }
      let response: Response;
      try {
        response = await fetch(this.gatewayUrl("/plugins/secrets-gateway/open/proxy"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.gatewayToken()}`,
            "content-type": "application/json",
          },
          signal: this.gatewaySignal(init.signal ?? undefined),
          body: JSON.stringify({
            secret: name,
            url,
            method: init.method ?? "GET",
            headers: targetHeaders,
            ...payload,
          }),
        });
      } catch (error) {
        this.audit(plugin, name, "fetch", "refused", conversationId);
        throw new Error(`secret "${name}" gateway request failed: ${messageOf(error)}`, {
          cause: error,
        });
      }
      this.audit(
        plugin,
        name,
        "fetch",
        response.status === 403 ? "refused" : "used",
        conversationId,
      );
      return response;
    }
    const value = this.resolve(name);
    const allowed = definition.hosts ?? [];
    const headers = new Headers(init.headers);
    if (!definition.apply) {
      this.audit(plugin, name, "fetch", "refused", conversationId);
      throw new Error(`secret "${name}" has no apply rule`);
    }
    let method = init.method ?? "GET";
    let body = init.body;
    let target = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowed.some((entry) => hostAllowed(entry, target))) {
        this.audit(plugin, name, "fetch", "refused", conversationId);
        throw new Error(`secret "${name}" may not be sent to host "${hostLabel(target)}"`);
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
        this.audit(plugin, name, "fetch", "used", conversationId);
        return "query" in definition.apply ? redactResponseUrl(response, value) : response;
      }
      const location = response.headers.get("location");
      if (!location) {
        this.audit(plugin, name, "fetch", "used", conversationId);
        return "query" in definition.apply ? redactResponseUrl(response, value) : response;
      }
      if (hop === MAX_REDIRECTS) {
        this.audit(plugin, name, "fetch", "refused", conversationId);
        throw new Error(`secret "${name}" redirect limit exceeded at host "${hostLabel(target)}"`);
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
    this.requireDeclared(plugin, name, "get", conversationId);
    if (this.backend.kind === "gateway") {
      let response: Response;
      try {
        response = await fetch(this.gatewayUrl("/plugins/secrets-gateway/open/raw"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.gatewayToken()}`,
            "content-type": "application/json",
          },
          signal: this.gatewaySignal(),
          body: JSON.stringify({ secret: name }),
        });
      } catch (error) {
        this.audit(plugin, name, "get", "refused", conversationId);
        throw new Error(`secret "${name}" gateway request failed: ${messageOf(error)}`, {
          cause: error,
        });
      }
      if (!response.ok) {
        this.audit(plugin, name, "get", "refused", conversationId);
        throw new Error(`secret "${name}" raw access refused (${response.status})`);
      }
      let body: { value?: unknown };
      try {
        body = (await response.json()) as { value?: unknown };
      } catch {
        this.audit(plugin, name, "get", "refused", conversationId);
        throw new Error(`secret "${name}" raw access returned invalid JSON`);
      }
      if (typeof body.value !== "string") {
        this.audit(plugin, name, "get", "refused", conversationId);
        throw new Error(`secret "${name}" raw access returned no value`);
      }
      this.audit(plugin, name, "get", "used", conversationId);
      return body.value;
    }
    const value = this.resolve(name);
    this.audit(plugin, name, "get", "used", conversationId);
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

/** A host entry's host and optional port: `[::1]:8080`, `example.com:443`, `::1`. */
function splitHostEntry(entry: string): { host: string; port?: string } {
  const value = entry.trim();
  if (value.startsWith("[")) {
    const match = /^\[(.+)\](?::(\d+))?$/.exec(value);
    if (match) return { host: match[1]!, port: match[2] };
  }
  const colon = value.lastIndexOf(":");
  if (colon > 0 && value.indexOf(":") === colon) {
    const port = value.slice(colon + 1);
    if (/^\d+$/.test(port)) return { host: value.slice(0, colon), port };
  }
  return { host: value };
}

function normalizedHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** The URL's effective port, including the protocol default. */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "http:") return "80";
  if (url.protocol === "https:") return "443";
  return "";
}

/** The host and port a refusal names. */
function hostLabel(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/** Whether `url` matches a host entry; a plain host allows any port. */
function hostAllowed(entry: string, url: URL): boolean {
  const { host, port } = splitHostEntry(entry);
  if (normalizedHost(host) !== normalizedHost(url.hostname)) return false;
  return port === undefined || port === effectivePort(url);
}

/** Replace a query secret value in the response URL the plugin sees. */
function redactResponseUrl(response: Response, secret: string): Response {
  let url: URL;
  try {
    url = new URL(response.url);
  } catch {
    return response;
  }
  let changed = false;
  for (const [key, value] of url.searchParams) {
    if (value !== secret) continue;
    url.searchParams.set(key, "[redacted]");
    changed = true;
  }
  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const copy = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  Object.defineProperty(copy, "url", { value: url.toString(), configurable: true });
  return copy;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
