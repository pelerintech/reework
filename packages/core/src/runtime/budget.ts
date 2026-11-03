// The run budget: past `toolRoundsPerRun` tool rounds since the latest user input,
// tool calls are refused with guidance so the model answers with what it has; a
// model that keeps calling tools after a refusal has its run aborted.
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ConversationId, EntryRecord, Extension } from "@earendil-works/pi-durable";
import { CONTEXT } from "../engine.ts";
import type { Engine } from "../engine.ts";

export interface RunLimits {
  /** Tool rounds (one assistant reply's calls) allowed per run. Default unlimited. */
  readonly toolRoundsPerRun?: number;
}

const PAGE = 100;
/** How long a generation waits for its run's abort before going on regardless. */
const ABORT_GRACE_MS = 5_000;

/** Resolve when `signal` aborts (rejecting with its reason) or after `ms`. */
function abortedOr(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** An extension enforcing `limits`, or undefined when nothing is limited. */
export function budgetExtension(
  limits: RunLimits | undefined,
  engine: () => Engine,
  abort: (conversationId: string) => Promise<void>,
): Extension | undefined {
  const budget = limits?.toolRoundsPerRun;
  if (budget === undefined) return undefined;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new Error(`limits.toolRoundsPerRun must be a positive integer (got ${budget})`);
  }
  const refusal = `Tool budget for this request is used up (${budget} rounds). Do not call tools; answer now with what you have and say what is left undone.`;
  return defineExtension({
    name: "reework.limits",
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api) {
          if (call.parent) return undefined; // calls a tool makes itself are not rounds
          const rounds = await roundsSinceInput(engine(), api.conversationId);
          return rounds <= budget ? undefined : { block: refusal };
        },
      }),
      hook(GenerationTask, {
        // A model that was refused and called tools again does not get another request:
        // the run is aborted, and this generation ends on its own abort signal.
        async beforeRequest(_request, api) {
          const rounds = await roundsSinceInput(engine(), api.conversationId);
          if (rounds <= budget + 1) return undefined;
          const signal = (api as { signal?: AbortSignal }).signal;
          void abort(String(api.conversationId)).catch(() => {});
          await abortedOr(signal, ABORT_GRACE_MS);
          return undefined;
        },
      }),
    ],
  });
}

/** Whether an entry is user input, attributed (`reework.input`) or not (`pi.user`). */
export function isUserEntry(entry: EntryRecord): boolean {
  return entry.kind === "pi.user" || entry.kind === "reework.input";
}

/** Assistant replies with tool calls since the latest user entry (the current round included). */
async function roundsSinceInput(engine: Engine, conversationId: ConversationId): Promise<number> {
  const conversation = await engine.harness.conversation(conversationId, CONTEXT);
  if (!conversation) return 0;
  let rounds = 0;
  let cursor: Parameters<typeof conversation.entries>[2];
  for (;;) {
    const page = await conversation.entries({ order: "descending" }, PAGE, cursor, CONTEXT);
    for (const entry of page.items) {
      if (isUserEntry(entry)) return rounds;
      if (entry.kind === "pi.assistant" && callsTools(entry)) rounds += 1;
    }
    if (!page.next) return rounds;
    cursor = page.next;
  }
}

function callsTools(entry: EntryRecord): boolean {
  const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
  return (
    Array.isArray(content) && content.some((b) => (b as { type?: unknown }).type === "toolCall")
  );
}
