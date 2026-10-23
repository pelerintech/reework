import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  HarnessSettings,
  RegistryReader,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { StorageSeam } from "./tooling/storage.ts";
import { collectGatedRuns, hitlState } from "./hitl/gate.ts";
import type { HitlState } from "./hitl/gate.ts";

export const CONTEXT = BACKGROUND_CONTEXT;

/** Default agent: the mock (faux) model at the LLM boundary. */
function defaultAgent(): AgentChange {
  return { model: { provider: "faux", modelId: "faux-1" } };
}

/** The fallback catalog when none is given: the mock (faux) model, loaded only then. */
async function fallbackModels(): Promise<Models> {
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return models;
}

export interface EngineOptions {
  readonly storagePath: string;
  readonly models?: Models;
  readonly registry?: RegistryReader<ToolRegistration>;
  readonly settings?: HarnessSettings;
  /**
   * Give conversations with a `cwd` a local execution environment there, so the
   * coding tools act in that conversation's workspace.
   */
  readonly workspaces?: boolean;
}

/**
 * The reework core engine: a durable pi-durable harness opened over a sqlite
 * storage file. Proves crash-resume and durability of the foundation.
 */
export class Engine {
  readonly path: string;
  readonly harness: Harness;
  /** In-memory gate state owned by this engine's registry. */
  readonly hitl: HitlState;
  private readonly models?: Models;

  private constructor(harness: Harness, path: string, hitl: HitlState, models?: Models) {
    this.harness = harness;
    this.path = path;
    this.hitl = hitl;
    this.models = models;
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const models = options.models ?? (await fallbackModels());
    const registry = options.registry ?? createRegistry();
    const storage = await openNodeSqliteStorage(options.storagePath);
    collectGatedRuns(registry);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.workspaces
          ? {
              env: ({ cwd }: { cwd?: string }) => (cwd ? new NodeExecutionEnv({ cwd }) : undefined),
            }
          : {}),
      },
      CONTEXT,
    );
    const engine = new Engine(harness, options.storagePath, hitlState(registry), models);
    engine.hitl.storage = engine.storage;
    return engine;
  }

  /** Return the reserved root conversation, with optional agent changes. */
  root(agent?: AgentChange): ReturnType<Harness["root"]> {
    return this.harness.root(CONTEXT, { agent: agent ?? defaultAgent() });
  }

  /** Drive a conversation to completion: admit input and wait for the answer. */
  async run(content: string, agent?: AgentChange): Promise<string> {
    const root = await this.harness.root(CONTEXT, { agent: agent ?? defaultAgent() });
    const submission = await root.submit({ type: "input", content }, CONTEXT);
    const settled = await submission.wait(CONTEXT);
    if (settled.status === "done" && settled.type === "input") {
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), CONTEXT);
      return extractText(entry);
    }
    throw new Error(`run did not complete: ${settled.status}`);
  }

  /** Enable task scheduling, continuing any run the last process left unfinished. */
  resume(): void {
    this.harness.resume();
  }

  /** Commit an atomic change on the harness's session mutation line. */
  commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T> {
    return this.harness.commit(change, CONTEXT);
  }

  close(): Promise<void> {
    return this.harness.close(CONTEXT);
  }

  /** The common tooling storage seam, bound to this engine's shared store. */
  get storage(): StorageSeam {
    return new StorageSeam(this);
  }
}

/** Extract the text of an assistant entry's first message. */
function extractText(entry: unknown): string {
  const content =
    (entry as { model?: readonly { content?: readonly unknown[] }[] } | undefined)?.model?.[0]
      ?.content ?? [];
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b && b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
}

export { createRegistry, Harness };
