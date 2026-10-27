// Two test plugins proving hook order and the memo rule: a guard (blocks by
// argument pattern, rewrites args, redacts request/result text) and an audit
// (records requests, responses, tool calls with outcome, answers, compactions).
// They share an `events` array the test inspects, so the fixture needs no
// durable store (hooks run outside a tool call's commit).
import { definePlugin } from "@reework/core";

/** A guard: blocks `echo` whose text contains "block", rewrites "rewrite*",
 *  redacts "SECRET" from results and "secret-word" from requests. */
export function guardPlugin(events: string[]): ReturnType<typeof definePlugin> {
  return definePlugin("guard", () => ({
    hooks: {
      async beforeTool({ name, args }) {
        const text = (args as { text?: string }).text ?? "";
        if (name === "echo" && text.includes("block")) {
          events.push("guard:block");
          return { block: "blocked by guard" };
        }
        if (name === "echo" && text.startsWith("rewrite")) {
          events.push("guard:rewrite");
          return { args: { text: "rewritten" } };
        }
        return undefined;
      },
      async afterTool(_call, result) {
        return { output: result.output.replace("SECRET", "[redacted]") };
      },
      async beforeModelRequest({ messages }) {
        return {
          messages: messages.map((m) => ({
            ...m,
            content:
              typeof m.content === "string"
                ? m.content.replace("secret-word", "[redacted]")
                : m.content,
          })),
        };
      },
    },
  }));
}

/** An audit: records every phase into `events`, with the outcome of each tool call. */
export function auditPlugin(events: string[]): ReturnType<typeof definePlugin> {
  return definePlugin("audit", () => ({
    hooks: {
      async beforeModelRequest({ messages }) {
        events.push(`request:${messages.length}`);
        return undefined;
      },
      async afterModelResponse({ message }) {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        events.push(`response:${text}`);
      },
      async beforeTool({ name }) {
        events.push(`tool-before:${name}`);
        return undefined;
      },
      async afterTool(call, result) {
        events.push(`tool-after:${call.name}:${result.isError ? "blocked" : "ok"}`);
        return result;
      },
      async onAnswer({ text }) {
        events.push(`answer:${text}`);
        return undefined;
      },
      async beforeCompaction() {
        events.push("compaction");
        return undefined;
      },
    },
  }));
}
