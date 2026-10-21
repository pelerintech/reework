// Exactly-once helpers for tool effects across crash and replay (patterns from
// disler/pi-durable-news-agent). A tool marked `replay: "safe"` reruns after a
// restart; these keep its effects from happening twice.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";

/** Task-scoped receipt: an effect and its record commit together. */
const TaskReceipt = defineDoc<{ value: JsonValue }>({
  kind: "reework.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ value: null }),
});

/**
 * Run `fn` inside one commit at most once per tool call, for effects that are
 * themselves commits (creating a task, a proposal, a conversation). A replay
 * returns the stored value instead of committing again.
 */
export async function onceInCommit<T extends JsonValue>(
  api: ToolExecutionApi,
  context: Context,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return api.commit(async (tx) => {
    const receipt = (await tx.doc(TaskReceipt, api.taskId)) as { value: JsonValue };
    if (receipt.value !== null) return receipt.value as T;
    const value = await fn(tx);
    receipt.value = value;
    return value;
  }, context);
}

/**
 * Run an external effect at most once per tool call and key, keeping its result
 * in the call's durable memo. A crash between the effect and the memo repeats
 * the effect, so the effect itself must be idempotent (e.g. keyed by name).
 */
export async function once<T extends JsonValue>(
  api: ToolExecutionApi,
  key: string,
  context: Context,
  fn: () => Promise<T>,
): Promise<T> {
  const done = await api.memo<T>(key, context);
  if (done !== undefined) return done;
  return api.memo<T>(key, await fn(), context);
}
