import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type {
  ConversationDocFamilyToken,
  ConversationDocToken,
  ConversationId,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";

/**
 * The engine's durable storage seam, exposed to core components and Layer-2
 * plugins. Backed by pi-durable's `defineDoc`/`defineDocFamily` primitives, so
 * component/plugin state lives in the same sqlite store as the engine.
 */
export class StorageSeam {
  readonly defineDoc = defineDoc;
  readonly defineDocFamily = defineDocFamily;

  constructor(private readonly engine: Engine) {}

  /** Run an atomic commit that mutates durable state inside the shared store. */
  commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T> {
    return this.engine.commit(change);
  }

  /** Read a conversation-scoped document's current value. */
  async readDoc<T extends JsonObject>(
    token: ConversationDocToken<T>,
    conversationId: ConversationId,
  ): Promise<Readonly<T> | undefined> {
    return this.engine.harness.snapshot(token, conversationId, CONTEXT);
  }

  /** Read a conversation-scoped family document by key. */
  async readFamily<T extends JsonObject>(
    token: ConversationDocFamilyToken<T, JsonValue>,
    conversationId: ConversationId,
    key: string,
  ): Promise<Readonly<T> | undefined> {
    return this.engine.harness.snapshot(token, conversationId, key, CONTEXT);
  }

  /** Mutate a conversation-scoped document in the shared store. */
  async writeDoc<T extends JsonObject>(
    token: ConversationDocToken<T>,
    conversationId: ConversationId,
    change: (value: T) => void,
  ): Promise<void> {
    await this.engine.commit(async (tx) => {
      change((await tx.doc(token, conversationId)) as T);
    });
  }

  /** Mutate a conversation-scoped family document in the shared store. */
  async writeFamily<T extends JsonObject, I extends JsonValue>(
    token: ConversationDocFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
    seed: I,
    change: (value: T) => void,
  ): Promise<void> {
    await this.engine.commit(async (tx) => {
      change((await tx.doc(token, conversationId, key, seed)) as T);
    });
  }
}
