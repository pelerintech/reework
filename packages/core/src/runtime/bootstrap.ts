import { createRegistry } from "@earendil-works/pi-durable";
import type { AgentDefinition } from "../agent-definition.ts";
import { Engine } from "../engine.ts";
import { createServer } from "../server/index.ts";

export interface StartAgentOptions {
  /** Path to the durable sqlite storage the engine opens over. */
  storagePath: string;
}

export interface RunningAgent {
  readonly agent: AgentDefinition;
  readonly engine: Engine;
  readonly app: ReturnType<typeof createServer>["app"];
  /** Stop the engine and any server resources. */
  stop(): Promise<void>;
}

/**
 * Bootstrap a runnable agent from a definition: open the durable engine over
 * storage, install each declared plugin (passing its config to `init`),
 * wire the server, and return the running agent.
 */
export async function startAgent(
  agent: AgentDefinition,
  options: StartAgentOptions,
): Promise<RunningAgent> {
  const engine = await Engine.open({ storagePath: options.storagePath });

  for (const declared of agent.plugins) {
    const plugin = declared.plugin as {
      init?(engine: Engine, config: unknown): Promise<void> | void;
    };
    await plugin.init?.(engine, declared.config);
  }

  for (const declared of agent.channels) {
    const channel = declared.plugin as {
      init?(engine: Engine, config: unknown): Promise<void> | void;
    };
    await channel.init?.(engine, declared.config);
  }

  const { app } = createServer(engine);

  return {
    agent,
    engine,
    app,
    async stop() {
      await engine.close();
    },
  };
}

export { createRegistry };
