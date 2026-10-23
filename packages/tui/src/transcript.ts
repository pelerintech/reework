// The transcript as styled lines: what the conversation view shows, independent of Ink.
import type { ConversationView, ViewItem } from "@reework/client";

export type TranscriptStyle = "user" | "assistant" | "tool" | "tool-error" | "dim";

export interface TranscriptLine {
  readonly text: string;
  readonly style: TranscriptStyle;
}

/** Lines of the whole transcript, oldest first; `now` times running tools. */
export function transcriptLines(view: ConversationView, now: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const item of view.items) lines.push(...itemLines(item, now));
  return lines;
}

function itemLines(item: ViewItem, now: number): TranscriptLine[] {
  if (item.type === "tool") {
    const took = formatDuration((item.endedAt ?? now) - item.startedAt);
    const status =
      item.status === "running"
        ? `running ${took}`
        : item.status === "error"
          ? `failed · ${took}`
          : `done · ${took}`;
    return [
      {
        text: `  ⚙ ${item.name}  ${status}`,
        style: item.status === "error" ? "tool-error" : "tool",
      },
    ];
  }
  const who = item.role === "user" ? "you" : "agent";
  const body = item.text.split("\n");
  return [
    ...body.map((text, i) => ({
      text: i === 0 ? `${who}: ${text}` : `     ${text}`,
      style: item.role === "user" ? ("user" as const) : ("assistant" as const),
    })),
    ...(item.type === "message" && item.streaming
      ? [{ text: "     …", style: "dim" as const }]
      : []),
  ];
}

/** `850ms`, `12s`, `2m05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
