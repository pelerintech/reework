// The membership and identity rules of the agent-wide activity stream. The
// snapshot read and the live hub apply the same rule, so a filtered stream never
// carries a conversation outside its filter.
import type { ActivityFilter, Case, CaseKind } from "@reework/types";
import type { ConversationRecord } from "./conversations.ts";

/** Whether a conversation record matches an activity filter (both filters AND). */
export function activityMatches(
  record: Pick<ConversationRecord, "key" | "tags">,
  filter?: ActivityFilter,
): boolean {
  if (!filter) return true;
  if (filter.keyPrefix !== undefined) {
    if (record.key === undefined || !record.key.startsWith(filter.keyPrefix)) return false;
  }
  if (filter.tag?.length) {
    const tags = record.tags ?? [];
    if (!filter.tag.every((t) => tags.includes(t))) return false;
  }
  return true;
}

/** Whether a conversation is open work: a desk or an open/waiting case. */
export function activityOpenWork(record: Pick<ConversationRecord, "kind" | "status">): boolean {
  return (record.kind ?? "case") === "desk" || (record.status ?? "open") !== "closed";
}

/** The conversation identity an activity frame carries. */
export function activityConversation(record: Pick<ConversationRecord, "id" | "key" | "kind">): {
  conversationId: string;
  key?: string;
  caseKind: CaseKind;
} {
  return {
    conversationId: record.id,
    ...(record.key === undefined ? {} : { key: record.key }),
    caseKind: record.kind ?? "case",
  };
}

/** A conversation record's fields as a case write leaves them. */
export function recordOfCase(c: Case): ConversationRecord {
  return {
    id: c.id,
    ...(c.key === undefined ? {} : { key: c.key }),
    createdAt: c.createdAt,
    kind: c.kind,
    status: c.status,
    priority: c.priority,
    tags: c.tags,
    ...(c.stage === undefined ? {} : { stage: c.stage }),
    ...(c.owner === undefined ? {} : { owner: c.owner }),
    caseUpdatedAt: c.updatedAt,
  };
}
