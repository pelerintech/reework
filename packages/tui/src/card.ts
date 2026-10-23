// A proposal as a compact card, and the pane an opened attachment scrolls in.
import type { Proposal } from "@reework/types";
import { formatAttachment } from "./format.ts";
import type { StyledLine } from "./format.ts";

export interface CardFocus {
  /** Whether the card has the keyboard. */
  readonly focused: boolean;
  /** Highlighted option. */
  readonly option: number;
  /** Opened attachment, or -1 when all are folded. */
  readonly open: number;
}

export interface CardLine {
  readonly text: string;
  readonly style: "title" | "meta" | "attachment" | "option" | "selected" | "hint";
}

/** The folded card: title, one line per attachment, the options. */
export function cardLines(proposal: Proposal, focus: CardFocus): CardLine[] {
  const lines: CardLine[] = [
    { text: proposal.title, style: "title" },
    { text: `conversation ${proposal.conversationId}`, style: "meta" },
  ];
  (proposal.attachments ?? []).forEach((attachment, i) => {
    const count = attachment.content.split("\n").length;
    const marker = focus.open === i ? "▾" : "▸";
    lines.push({
      text: `  ${marker} ${attachment.title ?? attachment.kind} (${attachment.kind}, ${count} lines)`,
      style: "attachment",
    });
  });
  proposal.options.forEach((option, i) => {
    const selected = focus.focused && focus.option === i;
    lines.push({
      text: `${selected ? "›" : " "} ${option.label}`,
      style: selected ? "selected" : "option",
    });
  });
  if (focus.focused) {
    const freeForm = proposal.acceptFreeForm ? " · or type an instruction" : "";
    lines.push({
      text: `↑↓ choose · Enter decide · → open attachment · Esc back${freeForm}`,
      style: "hint",
    });
  } else {
    lines.push({ text: "Tab to answer", style: "hint" });
  }
  return lines;
}

/** The visible part of an opened attachment, `height` lines from `offset`. */
export function paneLines(
  proposal: Proposal,
  open: number,
  offset: number,
  height: number,
): { lines: StyledLine[]; offset: number; total: number } {
  const attachment = proposal.attachments?.[open];
  if (!attachment) return { lines: [], offset: 0, total: 0 };
  const all = formatAttachment({ ...attachment, title: undefined });
  const max = Math.max(0, all.length - height);
  const start = Math.min(Math.max(0, offset), max);
  return { lines: all.slice(start, start + height), offset: start, total: all.length };
}
