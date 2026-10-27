// The core `update_case` model tool and the case section. This is framework
// tooling: a reework `ReeworkTool` (converted to pi-durable in the facade) and a
// `section` that shows the conversation's current case.
import { defineExtension } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { Case, CasePatch } from "@reework/types";
import type { CaseToolField } from "../agent-definition.ts";
import { defineTool, readCase, section, toDurableTool, Type } from "./facade.ts";
import type { PluginBindings, ReeworkTool, ToolContext } from "./facade.ts";

const ALL_FIELDS: CaseToolField[] = [
  "title",
  "summary",
  "status",
  "stage",
  "priority",
  "tags",
  "dueAt",
];

function schemaFor(field: CaseToolField) {
  if (field === "dueAt") return Type.Optional(Type.Number());
  if (field === "tags") return Type.Optional(Type.Array(Type.String()));
  return Type.Optional(Type.String());
}

function patchFrom(args: Record<string, unknown>): CasePatch {
  const patch: CasePatch = {};
  for (const field of ALL_FIELDS) {
    if (args[field] !== undefined) (patch as Record<string, unknown>)[field] = args[field];
  }
  return patch;
}

function summaryOf(c: Case): string {
  const bits: string[] = [`status=${c.status}`, `priority=${c.priority}`];
  if (c.stage) bits.push(`stage=${c.stage}`);
  if (c.title) bits.push(`title=${c.title}`);
  if (c.tags.length) bits.push(`tags=${c.tags.join(",")}`);
  return bits.join(" ");
}

/** Build the `update_case` tool over the allowed field set. */
export function updateCaseTool(fields: readonly CaseToolField[] = ALL_FIELDS): ReeworkTool {
  const properties: Record<string, ReturnType<typeof schemaFor>> = {};
  for (const field of fields) properties[field] = schemaFor(field);
  const parameters = Type.Object(properties, { additionalProperties: false });
  return defineTool({
    name: "update_case",
    description:
      "Update the current conversation's case (title, summary, stage, priority, tags, due date, status). Only set the fields you want to change; the rest are left as they are.",
    parameters,
    async execute(args, ctx: ToolContext) {
      const c = await ctx.case.update(patchFrom(args));
      return `case updated: ${summaryOf(c)}`;
    },
  });
}

/** The core case extension: the `update_case` tool and the case section. */
export function caseExtension(
  fields: readonly CaseToolField[] = ALL_FIELDS,
  bindings?: PluginBindings,
): Extension {
  const tool = updateCaseTool(fields);
  const caseSection = section("case", async ({ conversationId }) => {
    const c = await readCase(conversationId, bindings);
    return `Current case: ${summaryOf(c)}`;
  });
  return defineExtension({
    name: "reework.case",
    tools: [toDurableTool(tool, "reework.case", bindings)],
    sections: [caseSection],
  });
}
