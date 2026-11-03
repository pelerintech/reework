import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  ConversationId,
  HarnessSettings,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { PLUGIN_ROUTE_PREFIX } from "@reework/types";
import type { AgentDefinition, DeclaredModule } from "../agent-definition.ts";
import { CONTEXT, Engine } from "../engine.ts";
import { installHITL } from "../hitl/gate.ts";
import { AgentHost } from "../host.ts";
import { createServer } from "../server/index.ts";
import { protocolErrorResponse, requireToken } from "../server/app.ts";
import { buildToolHooks, toDurableTool, toExtension } from "../tooling/facade.ts";
import type {
  BuiltPlugin,
  PluginBindings,
  PluginEventContext,
  PluginHooks,
  PluginRouteContext,
  ReeworkTool,
} from "../tooling/facade.ts";
import { caseExtension } from "../tooling/case-tool.ts";
import { createPluginStore } from "../tooling/plugin-store.ts";
import { createPluginContextMembers } from "../tooling/facade.ts";
import { EventDispatcher } from "./events.ts";
import { onProposalSettled } from "../protocol/proposals.ts";

import { budgetExtension } from "./budget.ts";
import { lockStorage } from "./lock.ts";
import type { LockOptions } from "./lock.ts";
import { customModels, MODEL_PROVIDER_ID } from "./models.ts";

export { MODEL_PROVIDER_ID };

export interface StartAgentOptions {
  /** Path to the durable sqlite storage the engine opens over. */
  storagePath: string;
  /** Model catalog override (tests use faux under `MODEL_PROVIDER_ID`). */
  models?: Models;
  /**
   * API auth: the bearer token itself (`token`), or the variable holding it
   * (`tokenEnv`, default `REEWORK_API_TOKEN`). `token` wins.
   */
  auth?: { token?: string; tokenEnv?: string };
  /** Storage lock timing (tests shorten the heartbeat). */
  lock?: LockOptions;
  /** Overrides for the harness run policy, merged over the defaults below. */
  settings?: Partial<Pick<HarnessSettings, "stream" | "retry">>;
}

/** Run-policy defaults for real endpoints: bounded streams, retries with backoff. */
const DEFAULT_SETTINGS = {
  stream: { timeoutMs: 180_000, maxRetries: 2 },
  retry: { enabled: true, maxRetries: 4, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
} satisfies Pick<HarnessSettings, "stream" | "retry">;

export interface RunningAgent {
  readonly agent: AgentDefinition;
  readonly host: AgentHost;
  readonly app: ReturnType<typeof createServer>["app"];
  /** Serve the app (REST + WebSocket) on `port`; `0` picks a free port. */
  listen(port: number, hostname?: string): Promise<{ port: number; close: () => Promise<void> }>;
  /**
   * Stop the server and the engine (running tools get their abort signal) and release
   * the storage lock. Rejects if the engine has not closed within `timeoutMs` (default
   * 8000, below Docker's 10 s stop grace); the lock is released either way.
   */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * Bootstrap a runnable agent from a definition: build every declared plugin
 * from its config, install them into one registry, open the durable engine over
 * it, and wire the host and server.
 */
export async function startAgent(
  agent: AgentDefinition,
  options: StartAgentOptions,
): Promise<RunningAgent> {
  const tokenEnv = options.auth?.tokenEnv ?? "REEWORK_API_TOKEN";
  const token = options.auth?.token ?? process.env[tokenEnv];
  if (!token) throw new Error(`API token variable ${tokenEnv} is not set`);
  const models = options.models ?? customModels(agent.model, agent.models);
  const lifecycle = new AbortController();
  const built: Built[] = [];
  const opened: Opened = {};
  let unlock: (() => void) | undefined;
  let stopped = false;
  // Any failure after a plugin was built aborts its signal and stops it, so a
  // factory's connection or a setup's loop does not leak.
  const stopBuilt = async () => {
    if (stopped) return;
    stopped = true;
    lifecycle.abort();
    await stopPlugins(built);
  };
  try {
    for (const declared of [...agent.plugins, ...agent.channels]) {
      built.push(await buildPlugin(declared));
    }
    validateNamedModels(agent, built);
    validatePluginRouteNames(built);
    if (options.models) {
      for (const name of Object.keys(agent.models ?? {})) {
        if (options.models.getModels(`reework.model.${name}`).length === 0) {
          throw new Error(`model catalog is missing named model "${name}"`);
        }
      }
    }
    // One capabilities object per agent: its model catalog and each plugin's lent
    // names, plus the host-backed case/file access filled in once the host exists.
    const bindings: PluginBindings = {
      catalog: models,
      lent: new Map(built.map((p) => [p.name, p.models])),
    };

    const registry = createRegistry();
    installHITL(registry, bindings);
    registry.install(
      defineExtension({
        name: "reework.mission",
        sections: [section("mission", () => agent.mission.role, { tag: false })],
      }),
    );
    const caseModelTool = agent.cases?.modelTool;
    if (caseModelTool !== false) {
      registry.install(caseExtension(caseModelTool?.fields, bindings));
    }
    for (const plugin of built) registry.install(toExtension(plugin.name, plugin.built, bindings));
    const toolHooks = buildToolHooks(
      built
        .map((p) => ({ name: p.name, hooks: p.built.hooks }))
        .filter((p): p is { name: string; hooks: PluginHooks } => p.hooks !== undefined),
      bindings,
    );
    if (toolHooks)
      registry.install(defineExtension({ name: "reework.pluginHooks", hooks: [toolHooks] }));
    // The engine and host exist only once boot opens them (before any run resumes).
    const budget = budgetExtension(
      agent.limits,
      () => opened.engine!,
      (id) => opened.host!.abort(id),
    );
    if (budget) registry.install(budget);

    const modelTools = agent.mission.tools
      ? selectTools(built, agent.mission.tools, bindings)
      : undefined;
    const providers = built.filter((plugin) => plugin.built.workspace);
    if (providers.length > 1) {
      const names = providers.map((p) => `"${p.name}"`).join(" and ");
      throw new Error(`only one plugin may provide workspaces; both ${names} do`);
    }
    unlock = await lockStorage(options.storagePath, options.lock);
    return await boot(
      agent,
      options,
      models,
      built,
      bindings,
      registry,
      modelTools,
      token,
      unlock,
      opened,
      lifecycle,
    );
  } catch (error) {
    unlock?.();
    await stopBuilt();
    if (opened.engine) await opened.engine.close().catch(() => {});
    throw error;
  }
}

async function boot(
  agent: AgentDefinition,
  options: StartAgentOptions,
  models: Models,
  built: readonly Built[],
  bindings: PluginBindings,
  registry: ReturnType<typeof createRegistry>,
  modelTools: ToolRegistration[] | undefined,
  token: string,
  unlock: () => void,
  opened: Opened,
  lifecycle: AbortController,
): Promise<RunningAgent> {
  const settings: HarnessSettings = {
    stream: { ...DEFAULT_SETTINGS.stream, ...options.settings?.stream },
    retry: { ...DEFAULT_SETTINGS.retry, ...options.settings?.retry },
  };
  const engine = await Engine.open({
    storagePath: options.storagePath,
    models,
    registry,
    settings,
    workspaces: true,
  });
  const agentChange: AgentChange = {
    model: { provider: MODEL_PROVIDER_ID, modelId: agent.model.modelId },
    ...(modelTools ? { modelTools } : {}),
  };
  const workspace = built.find((plugin) => plugin.built.workspace)?.built.workspace;
  const events = new EventDispatcher(
    built
      .map((plugin) => ({ name: plugin.name, hooks: plugin.built.hooks }))
      .filter(
        (plugin): plugin is { name: string; hooks: PluginHooks } => plugin.hooks !== undefined,
      ),
    (plugin, conversationId) =>
      ({
        conversationId,
        ...createPluginContextMembers(
          createPluginStore(
            { commit: (fn) => engine.commit(fn) },
            plugin,
            conversationId as unknown as ConversationId,
          ),
          conversationId,
          bindings,
          plugin,
        ),
      }) as PluginEventContext,
    lifecycle.signal,
  );
  onProposalSettled(engine, ({ proposal, decision }) => {
    if (!proposal) return;
    events.enqueue("onDecision", proposal.conversationId, { proposal, decision });
  });
  const host = new AgentHost(
    engine,
    agentChange,
    workspace,
    { maxBytes: agent.files?.maxBytes },
    events,
  );
  opened.engine = engine;
  opened.host = host;
  bindings.case = {
    get: (id) => host.getCase(id),
    update: (id, patch) => host.updateCase(id, patch),
  };
  bindings.files = {
    list: (id) => host.listFiles(id),
    read: (id, fid) => host.readFile(id, fid),
    add: (id, input) => host.addFile(id, input),
  };
  for (const plugin of built) {
    const dataDir = pluginDataDir(options.storagePath, plugin.name);
    if (plugin.built.setup || plugin.built.routes) mkdirSync(dataDir, { recursive: true });
    try {
      await plugin.built.setup?.({
        host,
        store: createPluginStore({ commit: (fn) => engine.commit(fn) }, plugin.name),
        config: plugin.config,
        signal: lifecycle.signal,
        dataDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`plugin "${plugin.name}" setup failed: ${message}`, { cause: error });
    }
  }
  const { app, nodeWebSocket } = createServer(host, { token, name: agent.name });
  mountPluginRoutes(app, built, host, engine, lifecycle.signal, token, options.storagePath);
  const beforeAgentRoutes = app.routes.length;
  agent.routes?.(app, host);
  const agentPluginRoute = app.routes
    .slice(beforeAgentRoutes)
    .find((route) => route.path.startsWith(`${PLUGIN_ROUTE_PREFIX}/`));
  if (agentPluginRoute) {
    throw new Error(`agent routes may not use the /plugins/ prefix (${agentPluginRoute.path})`);
  }
  // Continue whatever the previous process left unfinished: runs, gates, tasks.
  engine.resume();
  const servers = new Set<ServerType>();
  const closeServer = (server: ServerType) =>
    new Promise<void>((resolve) => {
      if (!servers.delete(server)) return resolve();
      server.close(() => resolve());
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });

  const running: RunningAgent & { engine: Engine } = {
    agent,
    engine,
    host,
    app,
    listen(port, hostname = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
          resolve({ port: info.port, close: () => closeServer(server) });
        });
        servers.add(server);
        nodeWebSocket.injectWebSocket(server);
        server.once("error", reject);
      });
    },
    async stop({ timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        await Promise.all([...servers].map(closeServer));
        lifecycle.abort();
        // Steps 3-5 (drain, plugin stops, engine close) share one deadline.
        const drained = await Promise.race([
          events.drain().then(() => "drained" as const),
          timedOut,
        ]);
        if (drained === "timeout") {
          void engine.close().catch(() => {});
          throw new Error(
            `agent did not stop within ${timeoutMs} ms; still running: queued event hooks`,
          );
        }
        let stopping: string | undefined;
        const stops = stopPlugins(built, (name) => (stopping = name));
        const stopped = await Promise.race([stops.then(() => "stopped" as const), timedOut]);
        if (stopped === "timeout") {
          void engine.close().catch(() => {});
          const name = stopping ?? [...built].reverse()[0]?.name ?? "unknown";
          throw new Error(
            `agent did not stop within ${timeoutMs} ms; plugin "${name}" still stopping`,
          );
        }
        const still = await stillRunning(engine);
        const closed = await Promise.race([engine.close().then(() => "closed" as const), timedOut]);
        if (closed === "timeout") {
          throw new Error(
            `agent did not stop within ${timeoutMs} ms; still running: ${still || "unknown work"}`,
          );
        }
      } finally {
        clearTimeout(timer);
        unlock();
      }
    },
  };
  return running;
}

const DEFAULT_STOP_TIMEOUT_MS = 8_000;

/** A plugin's persistent directory beside the agent's storage file. */
function pluginDataDir(storagePath: string, name: string): string {
  return resolve(`${storagePath}.plugins`, name);
}

/** Mount each plugin's routes under its prefix, behind the token by default. */
function mountPluginRoutes(
  app: Hono,
  built: readonly Built[],
  host: AgentHost,
  engine: Engine,
  signal: AbortSignal,
  token: string,
  storagePath: string,
): void {
  for (const plugin of built) {
    if (!plugin.built.routes) continue;
    const prefix = `${PLUGIN_ROUTE_PREFIX}/${plugin.name}`;
    const subApp = new Hono();
    const ctx: PluginRouteContext<unknown> = {
      host,
      store: createPluginStore({ commit: (fn) => engine.commit(fn) }, plugin.name),
      config: plugin.config,
      signal,
      dataDir: pluginDataDir(storagePath, plugin.name),
    };
    try {
      plugin.built.routes(subApp, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`plugin "${plugin.name}" routes failed: ${message}`, { cause: error });
    }
    subApp.onError((error, c) => {
      const mapped = protocolErrorResponse(error, c);
      if (mapped) return mapped;
      console.error(`[reework] plugin "${plugin.name}" route failed:`, error);
      return c.json({ error: "plugin_error", plugin: plugin.name }, 500);
    });
    const openPrefix = `${prefix}/open`;
    const hasOpen = subApp.routes.some(
      (route) => route.path === "/open" || route.path.startsWith("/open/"),
    );
    if (hasOpen) {
      console.warn(
        `[reework] plugin "${plugin.name}" serves unauthenticated routes under ${openPrefix}/`,
      );
    }
    const guard = requireToken(token);
    app.use(`${prefix}/*`, async (c, next) => {
      if (c.req.path === openPrefix || c.req.path.startsWith(`${openPrefix}/`)) return next();
      return guard(c, next);
    });
    app.route(prefix, subApp);
  }
}

/** Run every built plugin's `stop` in reverse declaration order; a failure is logged and skipped. */
async function stopPlugins(
  built: readonly Built[],
  onStart?: (name: string) => void,
): Promise<void> {
  for (const plugin of [...built].reverse()) {
    onStart?.(plugin.name);
    try {
      await plugin.built.stop?.();
    } catch (error) {
      console.error(`[reework] plugin "${plugin.name}" stop failed:`, error);
    }
  }
}

/** The running tasks, for a stop that times out: `<task kind> (conversation <id>)`. */
async function stillRunning(engine: Engine): Promise<string> {
  try {
    const inspection = await engine.harness.inspect(CONTEXT);
    return inspection.tasks
      .filter((task) => task.state.kind === "running")
      .map((task) => {
        const record = task.record as { kind?: string; conversationId?: number };
        return `${record.kind ?? "task"} (conversation ${record.conversationId ?? "-"})`;
      })
      .join(", ");
  } catch {
    return "";
  }
}

/** What hooks installed before the engine opens reach once it has. */
interface Opened {
  engine?: Engine;
  host?: AgentHost;
}

interface Built {
  readonly name: string;
  readonly config: unknown;
  readonly built: BuiltPlugin;
  readonly models: readonly string[];
}

function buildPlugin(declared: DeclaredModule): Promise<Built> {
  const name = declared.plugin.name;
  return Promise.resolve()
    .then(() => declared.plugin.build(declared.config))
    .then((built) => ({
      name,
      config: declared.config,
      built,
      models: declared.plugin.models ?? [],
    }))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`plugin "${name}" failed: ${message}`, { cause: error });
    });
}

/** A plugin with routes must have a name safe to use as one URL path segment. */
function validatePluginRouteNames(built: readonly Built[]): void {
  const safe = /^[a-z0-9][a-z0-9-]*$/;
  for (const plugin of built) {
    if (plugin.built.routes && !safe.test(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" has routes but its name is not URL-safe`);
    }
  }
}

/** Each plugin's required names must be declared; `main` is reserved; a passed-in
 *  catalog must cover the declared names. */
function validateNamedModels(agent: AgentDefinition, built: readonly Built[]): void {
  const declared = new Set(Object.keys(agent.models ?? {}));
  if (declared.has("main")) {
    throw new Error(`model name "main" is reserved; it names the conversation model`);
  }
  for (const plugin of built) {
    for (const name of plugin.models) {
      if (name === "main") {
        throw new Error(
          `plugin "${plugin.name}" needs model "main", which is reserved for the conversation model`,
        );
      }
      if (!declared.has(name)) {
        throw new Error(
          `plugin "${plugin.name}" needs model "${name}", which the agent does not declare`,
        );
      }
    }
  }
}

export { createRegistry };

/** The installed tools named in `mission.tools`; an unknown name stops startup. */
function selectTools(
  built: readonly Built[],
  names: readonly string[],
  bindings: PluginBindings,
): ToolRegistration[] {
  const byName = new Map<string, { tool: ReeworkTool; plugin: string }>();
  for (const plugin of built) {
    for (const tool of plugin.built.tools ?? [])
      byName.set(tool.name, { tool, plugin: plugin.name });
  }
  return names.map((name) => {
    const entry = byName.get(name);
    if (!entry) {
      throw new Error(`mission.tools names "${name}", which no plugin provides`);
    }
    return toDurableTool(entry.tool, entry.plugin, bindings);
  });
}
