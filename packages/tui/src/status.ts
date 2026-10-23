// The status bar's text: who the agent is and what it is doing.
import type { ConversationView } from "@reework/client";
import { formatDuration } from "./transcript.ts";

export function statusText(
  name: string | undefined,
  conversation: string | undefined,
  view: ConversationView | undefined,
  now: number,
): string {
  const parts = [name ?? "agent"];
  if (conversation) parts.push(conversation);
  if (view) {
    const tool = [...view.items].reverse().find((i) => i.type === "tool" && i.status === "running");
    if (tool && tool.type === "tool") {
      parts.push(`running ${tool.name} ${formatDuration(now - tool.startedAt)}`);
    } else {
      parts.push(view.running ? "thinking…" : "idle");
    }
  }
  return parts.join(" · ");
}
