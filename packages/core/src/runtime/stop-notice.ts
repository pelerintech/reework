// The durable record of a run a plugin stopped: the reason and the plugin that
// decided it, so a snapshot (and every client) can show it after the run ended.
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { RunStopNotice } from "@reework/types";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";

/** Durable, session-scoped stop notice of one conversation. */
export const RunStopDoc = defineDocFamily<
  { notice: { plugin: string; reason: string } | null },
  string
>({
  kind: "reework.runStop",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ notice: null }),
});

/** Record a plugin's stop of a conversation's run. */
export async function recordStopNotice(
  engine: Engine,
  conversationId: string,
  notice: RunStopNotice,
): Promise<void> {
  await engine.commit(async (tx) => {
    (await tx.doc(RunStopDoc, conversationId, conversationId)).notice = notice;
  });
}

/** The last plugin stop of a conversation's run, when one was recorded. */
export async function readStopNotice(
  engine: Engine,
  conversationId: string,
): Promise<RunStopNotice | undefined> {
  const doc = await engine.harness.snapshot(RunStopDoc, conversationId, CONTEXT);
  return doc?.notice ?? undefined;
}
