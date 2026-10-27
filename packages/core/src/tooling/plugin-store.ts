// Plugin storage: the facade store a plugin uses, namespaced by plugin name, at
// two scopes — `agent` (shared across every case) and `case` (this conversation).
// Backed by pi-durable doc families keyed `<plugin>/<key>`, with a per-plugin key
// index doc for `list`. Committed atomically with nothing else (not transactional
// with the run — documented).
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { PluginStore, PluginStoreScope } from "./facade.ts";

const agentDoc = defineDocFamily<{ value: JsonValue }, string>({
  kind: "reework.plugin.agent",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ value: null }),
});
const caseDoc = defineDocFamily<{ value: JsonValue }, string>({
  kind: "reework.plugin.case",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: () => ({ value: null }),
});
const agentIndex = defineDocFamily<{ keys: string[] }, string>({
  kind: "reework.plugin.agentIndex",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ keys: [] }),
});
const caseIndex = defineDocFamily<{ keys: string[] }, string>({
  kind: "reework.plugin.caseIndex",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: () => ({ keys: [] }),
});

/** The write/read boundary a plugin store runs over: a tool call or the engine. */
export interface StoreBackend {
  commit<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

function makeScope(
  backend: StoreBackend,
  scope: "agent" | "case",
  plugin: string,
  conversationId?: ConversationId,
): PluginStoreScope {
  const storeKey = (key: string) => `${plugin}/${key}`;
  const conv = conversationId;
  const doc = (tx: Tx, token: unknown, ...args: unknown[]) =>
    (tx.doc as unknown as (token: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>)(
      token,
      ...args,
    );
  const readRecord = async (tx: Tx, key: string): Promise<{ value: JsonValue | null }> =>
    scope === "agent"
      ? ((await doc(tx, agentDoc, storeKey(key), storeKey(key))) as { value: JsonValue | null })
      : ((await doc(tx, caseDoc, conv, storeKey(key), storeKey(key))) as {
          value: JsonValue | null;
        });
  const readIndex = async (tx: Tx): Promise<{ keys: string[] }> =>
    scope === "agent"
      ? ((await doc(tx, agentIndex, plugin, plugin)) as { keys: string[] })
      : ((await doc(tx, caseIndex, conv, plugin, plugin)) as { keys: string[] });

  const writeValue = async (tx: Tx, key: string, value: JsonValue | null) => {
    if (scope === "agent") {
      (await doc(tx, agentDoc, storeKey(key), storeKey(key))).value = value;
    } else {
      (await doc(tx, caseDoc, conv, storeKey(key), storeKey(key))).value = value;
    }
  };

  return {
    async get<T extends JsonValue>(key: string): Promise<T | undefined> {
      return backend.commit(
        async (tx) => ((await readRecord(tx, key)).value ?? undefined) as T | undefined,
      );
    },
    async set(key, value) {
      await backend.commit(async (tx) => {
        const index = await readIndex(tx);
        if (!index.keys.includes(key)) index.keys.push(key);
        await writeValue(tx, key, value);
      });
    },
    async update(key, change) {
      await backend.commit(async (tx) => {
        const current = (await readRecord(tx, key)).value ?? undefined;
        const next = change(current);
        const index = await readIndex(tx);
        if (!index.keys.includes(key)) index.keys.push(key);
        await writeValue(tx, key, next);
      });
    },
    async delete(key) {
      await backend.commit(async (tx) => {
        const index = await readIndex(tx);
        index.keys = index.keys.filter((k) => k !== key);
        await writeValue(tx, key, null);
      });
    },
    async list(prefix) {
      return backend.commit(async (tx) => {
        const index = await readIndex(tx);
        const matches = index.keys.filter((k) => k.startsWith(prefix));
        const items: { key: string; value: JsonValue }[] = [];
        for (const key of matches) {
          const value = (await readRecord(tx, key)).value ?? undefined;
          if (value !== undefined) items.push({ key, value });
        }
        return items;
      });
    },
  };
}

/** The plugin store for one plugin, at both scopes, over a write/read backend. */
export function createPluginStore(
  backend: StoreBackend,
  plugin: string,
  conversationId?: ConversationId,
): PluginStore {
  return {
    agent: makeScope(backend, "agent", plugin),
    ...(conversationId === undefined
      ? {}
      : { case: makeScope(backend, "case", plugin, conversationId) }),
  } as PluginStore;
}
