import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import type { AgentChange, HarnessSettings, ToolRegistration } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { AgentDefinition, DeclaredModule } from "../agent-definition.ts";
import { Engine } from "../engine.ts";
import { installHITL } from "../hitl/gate.ts";
import { AgentHost } from "../host.ts";
import { createServer } from "../server/index.ts";
import { toExtension } from "../tooling/facade.ts";
import type { BuiltPlugin } from "../tooling/facade.ts";

import { lockStorage } from "./lock.ts";
import { customModels, MODEL_PROVIDER_ID } from "./models.ts";

export { MODEL_PROVIDER_ID };

export interface StartAgentOptions {
  /** Path to the durable sqlite storage the engine opens over. */
  storagePath: string;
  /** Model catalog override (tests use faux under `MODEL_PROVIDER_ID`). */
  models?: Models;
  /** API auth: the variable holding the bearer token. Default `REEWORK_API_TOKEN`. */
  auth?: { tokenEnv?: string };
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
  readonly engine: Engine;
  readonly host: AgentHost;
  readonly app: ReturnType<typeof createServer>["app"];
  /** Serve the app (REST + WebSocket) on `port`; `0` picks a free port. */
  listen(port: number, hostname?: string): Promise<{ port: number; close(): Promise<void> }>;
  /** Stop the server, the engine, and release the storage lock. */
  stop(): Promise<void>;
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
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`API token variable ${tokenEnv} is not set`);
  const models = options.models ?? customModels(agent.model);
  const built = [...agent.plugins, ...agent.channels].map(buildPlugin);

  const registry = createRegistry();
  installHITL(registry);
  registry.install(
    defineExtension({
      name: "reework.mission",
      sections: [section("mission", () => agent.mission.role, { tag: false })],
    }),
  );
  for (const plugin of built) registry.install(toExtension(plugin.name, plugin.built));

  const modelTools = agent.mission.tools ? selectTools(built, agent.mission.tools) : undefined;
  const providers = built.filter((plugin) => plugin.built.workspace);
  if (providers.length > 1) {
    const names = providers.map((p) => `"${p.name}"`).join(" and ");
    throw new Error(`only one plugin may provide workspaces; both ${names} do`);
  }
  const unlock = lockStorage(options.storagePath);
  try {
    return await boot(agent, options, models, built, registry, modelTools, token, unlock);
  } catch (error) {
    unlock();
    throw error;
  }
}

async function boot(
  agent: AgentDefinition,
  options: StartAgentOptions,
  models: Models,
  built: readonly Built[],
  registry: ReturnType<typeof createRegistry>,
  modelTools: ToolRegistration[] | undefined,
  token: string,
  unlock: () => void,
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
  const host = new AgentHost(engine, agentChange, workspace);
  for (const plugin of built) {
    try {
      await plugin.built.setup?.({ host, storage: engine.storage, config: plugin.config });
    } catch (error) {
      await engine.close();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`plugin "${plugin.name}" setup failed: ${message}`, { cause: error });
    }
  }
  const { app, nodeWebSocket } = createServer(host, { token });
  agent.routes?.(app, host);
  // Continue whatever the previous process left unfinished: runs, gates, tasks.
  engine.resume();
  const servers = new Set<ServerType>();
  const closeServer = (server: ServerType) =>
    new Promise<void>((resolve) => {
      if (!servers.delete(server)) return resolve();
      server.close(() => resolve());
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });

  return {
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
    async stop() {
      try {
        await Promise.all([...servers].map(closeServer));
        await engine.close();
      } finally {
        unlock();
      }
    },
  };
}

interface Built {
  readonly name: string;
  readonly config: unknown;
  readonly built: BuiltPlugin;
}

function buildPlugin(declared: DeclaredModule): Built {
  const name = declared.plugin.name;
  try {
    return { name, config: declared.config, built: declared.plugin.build(declared.config) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`plugin "${name}" failed: ${message}`, { cause: error });
  }
}

export { createRegistry };

/** The installed tools named in `mission.tools`; an unknown name stops startup. */
function selectTools(built: readonly Built[], names: readonly string[]): ToolRegistration[] {
  const byName = new Map<string, ToolRegistration>();
  for (const plugin of built) {
    for (const tool of plugin.built.tools ?? []) byName.set(tool.name, tool);
  }
  return names.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`mission.tools names "${name}", which no plugin provides`);
    }
    return tool;
  });
}
