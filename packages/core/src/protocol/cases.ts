// Case logic: defaults, the stored⇄read normalization, patch validation, and the
// derived fields that follow open proposals.
import type { Author, Case, CaseKind, CasePatch, CasePriority, CaseStatus } from "@reework/types";
import { isAuthor, normalizeAuthor } from "@reework/types";
import type { ConversationRecord } from "./conversations.ts";

/** Read a conversation record's case fields, defaulting v05-shaped records. */
export function storedCaseOf(
  rec: Pick<
    ConversationRecord,
    | "createdAt"
    | "kind"
    | "title"
    | "summary"
    | "status"
    | "priority"
    | "stage"
    | "tags"
    | "dueAt"
    | "closedAt"
    | "owner"
    | "caseUpdatedAt"
  >,
): {
  kind: CaseKind;
  title?: string;
  summary?: string;
  status: CaseStatus;
  priority: CasePriority;
  stage?: string;
  tags: string[];
  dueAt?: number;
  closedAt?: number;
  owner?: Author;
  updatedAt: number;
} {
  return {
    kind: rec.kind ?? "case",
    ...(rec.title === undefined ? {} : { title: rec.title }),
    ...(rec.summary === undefined ? {} : { summary: rec.summary }),
    status: rec.status ?? "open",
    priority: rec.priority ?? "normal",
    ...(rec.stage === undefined ? {} : { stage: rec.stage }),
    tags: rec.tags ?? [],
    ...(rec.dueAt === undefined ? {} : { dueAt: rec.dueAt }),
    ...(rec.closedAt === undefined ? {} : { closedAt: rec.closedAt }),
    ...(rec.owner === undefined ? {} : { owner: rec.owner }),
    updatedAt: rec.caseUpdatedAt ?? rec.createdAt,
  };
}

/** The readable case for a record, with derived fields from open proposals. */
export function toCase(rec: ConversationRecord, openProposals: number): Case {
  const stored = storedCaseOf(rec);
  return {
    id: rec.id,
    ...(rec.key === undefined ? {} : { key: rec.key }),
    createdAt: rec.createdAt,
    kind: stored.kind,
    updatedAt: stored.updatedAt,
    ...(stored.title === undefined ? {} : { title: stored.title }),
    ...(stored.summary === undefined ? {} : { summary: stored.summary }),
    status: stored.status,
    ...(stored.stage === undefined ? {} : { stage: stored.stage }),
    priority: stored.priority,
    tags: stored.tags,
    ...(stored.dueAt === undefined ? {} : { dueAt: stored.dueAt }),
    ...(stored.closedAt === undefined ? {} : { closedAt: stored.closedAt }),
    ...(stored.owner === undefined ? {} : { owner: stored.owner }),
    needsHuman: openProposals > 0,
    openProposals,
  };
}

const VALID_STATUS: ReadonlySet<string> = new Set(["open", "waiting", "closed"]);
const VALID_PRIORITY: ReadonlySet<string> = new Set(["low", "normal", "high", "urgent"]);
const CASE_FIELDS = {
  title: 1,
  summary: 1,
  status: 1,
  stage: 1,
  priority: 1,
  tags: 1,
  dueAt: 1,
  owner: 1,
} as const;

/** Validate a case patch, returning each field rejected with the reason. */
export function validateCasePatch(patch: unknown): {
  ok: boolean;
  errors: Array<{ field: string; reason: string }>;
} {
  const errors: Array<{ field: string; reason: string }> = [];
  if (typeof patch !== "object" || patch === null) {
    return { ok: false, errors: [{ field: "patch", reason: "must be an object" }] };
  }
  const p = patch as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!(key in CASE_FIELDS)) errors.push({ field: key, reason: `unknown field` });
  }
  if ("status" in p && p.status !== undefined) {
    if (typeof p.status !== "string" || !VALID_STATUS.has(p.status)) {
      errors.push({ field: "status", reason: `must be one of open, waiting, closed` });
    }
  }
  if ("priority" in p && p.priority !== undefined) {
    if (typeof p.priority !== "string" || !VALID_PRIORITY.has(p.priority)) {
      errors.push({ field: "priority", reason: `must be one of low, normal, high, urgent` });
    }
  }
  if ("title" in p && p.title !== undefined && typeof p.title !== "string") {
    errors.push({ field: "title", reason: `must be a string` });
  }
  if ("summary" in p && p.summary !== undefined && typeof p.summary !== "string") {
    errors.push({ field: "summary", reason: `must be a string` });
  }
  if ("stage" in p && p.stage !== undefined) {
    if (typeof p.stage !== "string") errors.push({ field: "stage", reason: `must be a string` });
    else if (p.stage.length > 64)
      errors.push({ field: "stage", reason: `must be 64 chars or fewer` });
  }
  if ("tags" in p && p.tags !== undefined) {
    const tags = p.tags;
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
      errors.push({ field: "tags", reason: `must be an array of strings` });
    } else if (tags.length > 16) {
      errors.push({ field: "tags", reason: `must have 16 or fewer tags` });
    }
  }
  if (
    "dueAt" in p &&
    p.dueAt !== undefined &&
    (typeof p.dueAt !== "number" || !Number.isFinite(p.dueAt))
  ) {
    errors.push({ field: "dueAt", reason: `must be a number` });
  }
  if ("owner" in p && p.owner !== undefined && !isAuthor(p.owner)) {
    errors.push({ field: "owner", reason: `must be a valid author` });
  }
  return { ok: errors.length === 0, errors };
}

/** Apply a valid patch onto a conversation record, moving `caseUpdatedAt`. */
export function applyCasePatch(rec: ConversationRecord, patch: CasePatch, now = Date.now()): void {
  if (patch.title !== undefined) rec.title = patch.title;
  if (patch.summary !== undefined) rec.summary = patch.summary;
  if (patch.status !== undefined) {
    rec.status = patch.status as CaseStatus;
    if (patch.status === "closed") rec.closedAt = now;
    else delete rec.closedAt;
  }
  if (patch.stage !== undefined) rec.stage = patch.stage;
  if (patch.priority !== undefined) rec.priority = patch.priority as CasePriority;
  if (patch.tags !== undefined) rec.tags = patch.tags;
  if (patch.dueAt !== undefined) rec.dueAt = patch.dueAt;
  if (patch.owner !== undefined) rec.owner = normalizeAuthor(patch.owner);
  rec.caseUpdatedAt = now;
}
