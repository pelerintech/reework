import { defineDoc } from "@earendil-works/pi-durable";
import type { Author, CaseKind, CasePriority, CaseStatus } from "@reework/types";

/** A conversation the protocol created, as recorded durably. */
export type ConversationRecord = {
  id: string;
  key?: string;
  createdAt: number;
  /** The conversation's workspace directory, when a provider made one. */
  cwd?: string;
  // Case fields, stored flat on the record (absent on v05-shaped records).
  /** `case` or `desk`; absent on records stored before kinds existed (read as `case`). */
  kind?: CaseKind;
  title?: string;
  summary?: string;
  status?: CaseStatus;
  priority?: CasePriority;
  stage?: string;
  tags?: string[];
  dueAt?: number;
  closedAt?: number;
  owner?: Author;
  caseUpdatedAt?: number;
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
