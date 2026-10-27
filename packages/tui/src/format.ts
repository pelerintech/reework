import type { ProposalAttachment } from "@reework/types";

export type LineStyle = "title" | "file" | "hunk" | "added" | "removed" | "context" | "plain";

export interface StyledLine {
  readonly text: string;
  readonly style: LineStyle;
}

function diffStyle(line: string): LineStyle {
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** Lines of an attachment, styled by kind: diffs by line kind, other kinds as-is. */
export function formatAttachment(attachment: ProposalAttachment): StyledLine[] {
  if (attachment.kind === "file") {
    const info = `${attachment.name ?? attachment.fileId} — ${attachment.mimeType ?? "application/octet-stream"}, ${attachment.size ?? 0} bytes`;
    return [{ text: info, style: "plain" }];
  }
  const body = attachment.content.split("\n").map((text): StyledLine => ({
    text,
    style: attachment.kind === "diff" ? diffStyle(text) : "plain",
  }));
  return attachment.title ? [{ text: attachment.title, style: "title" }, ...body] : body;
}
