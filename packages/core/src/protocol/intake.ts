// The durable intake hold: whether new input is paused and the input accepted
// while it was. One session-scoped document, so a pause and a held input commit
// together and a restart forgets neither.
import { defineDoc } from "@earendil-works/pi-durable";
import type { Author } from "@reework/types";

/** An input accepted while intake was paused; it runs on resume, in arrival order. */
export type HeldInput = {
  /** The held input's own id; what `submitInput` returns while paused. */
  readonly id: string;
  readonly conversationId: string;
  /** The content as accepted: files already named in it. */
  readonly content: string;
  readonly from?: Author;
  /** The caller's deduplication key, passed through on resume. */
  readonly requestId?: string;
  readonly acceptedAt: number;
};

/**
 * Pause state and held input. Records stored before intake existed have no doc
 * and read as the `initial()` value, so a never-paused agent is unchanged.
 */
export const IntakeDoc = defineDoc<{
  paused: boolean;
  pausedAt?: number;
  resumedAt?: number;
  held: HeldInput[];
}>({
  kind: "reework.intake",
  version: 1,
  scope: "session",
  initial: () => ({ paused: false, held: [] }),
});
