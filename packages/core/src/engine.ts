import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import type { AgentChange, RegistryReader, ToolRegistration, Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { StorageSeam } from "./tooling/storage.ts";

export const CONTEXT = BACKGROUND_CONTEXT;

/** Default agent: the mock (faux) model at the LLM boundary. */
function defaultAgent(): AgentChange {
  return { model: { provider: "faux", modelId: "faux-1" } };
}

/** Build a Models catalog with a mock (faux) provider at the LLM boundary. */
export function createMockModels(): {
  models: Models;
  setResponses: (responses: unknown[]) => void;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    setResponses: (responses) => {
      // The faux provider validates queued responses as the harness consumes them.
      (faux as unknown as { setResponses: (r: unknown[]) => void }).setResponses(responses);
    },
  };
}

export interface EngineOptions {
  readonly storagePath: string;
  readonly models?: Models;
  readonly registry?: RegistryReader<ToolRegistration>;
}

/**
 * The reework core engine: a durable pi-durable harness opened over a sqlite
 * storage file. Proves crash-resume and durability of the foundation.
 */
export class Engine {
  readonly path: string;
  readonly harness: Harness;
  private readonly models?: Models;

  private constructor(harness: Harness, path: string, models?: Models) {
    this.harness = harness;
    this.path = path;
    this.models = models;
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const models = options.models ?? createMockModels().models;
    const registry = options.registry ?? createRegistry();
    const storage = await openNodeSqliteStorage(options.storagePath);
    const harness = await Harness.open(storage, { models, registry }, CONTEXT);
    return new Engine(harness, options.storagePath, models);
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
