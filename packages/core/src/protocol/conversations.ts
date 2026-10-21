import { defineDoc } from "@earendil-works/pi-durable";

/** A conversation the protocol created, as recorded durably. */
export type ConversationRecord = {
  id: string;
  key?: string;
  createdAt: number;
  /** The conversation's workspace directory, when a provider made one. */
  cwd?: string;
};

/**
 * Durable, session-scoped record of the conversations the host created: the
 * protocol's address book. Key lookups and listings read it; ids not in it
 * (including the agent's root) are not addressable.
 */
export const ConversationsDoc = defineDoc<{ conversations: ConversationRecord[] }>({
  kind: "reework.conversations",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: [] }),
});
