import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition, PluginHooks } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

interface Harness {
  readonly llm: FakeLlm;
  /** Submit input and await the answer; resolves to the assistant reply text. */
  readonly submit: (text: string) => Promise<string | undefined>;
}

function answerText(msg: { content: string | readonly { type: string }[] }): string {
  return typeof msg.content === "string"
    ? msg.content
    : msg.content.map((b) => (b.type === "text" && "text" in b ? b.text : "")).join("");
}

async function agentWith(hooks?: PluginHooks): Promise<Harness> {
  const llm = await startFakeLlm();
  const plugin = definePlugin("hooky", () => ({
    ...(hooks ? { hooks } : {}),
    tools: [
      defineTool({
        name: "echo",
        description: "Echo.",
        parameters: Type.Object({ text: Type.String() }),
        async execute(args) {
          return `echo:${args.text}`;
        },
      }),
    ],
  }));
  const def: AgentDefinition = {
    name: "h",
    model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "r" },
  };
  const agent = await startTestAgent(def, { models: undefined });
  const { id } = await agent.host.createConversation();
  const submit = (text: string) => agent.host.submitInput(id, text, { wait: true });
  return {
    llm,
    submit: async (text) => {
      const result = await submit(text);
      return result.message ? answerText(result.message) : undefined;
    },
  };
}

/** The user/assistant content strings sent in a recorded request's messages. */
function messageTexts(llm: FakeLlm): string[] {
  const req = llm.requests[0];
  if (!req) return [];
  const messages = (req.body.messages ?? []) as { role: string; content: string }[];
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

/** The non-system messages of the first request, as JSON, for round-trip comparison. */
function conversationMessages(llm: FakeLlm): string {
  const req = llm.requests[0];
  if (!req) return "";
  const messages = (req.body.messages ?? []) as { role: string }[];
  return JSON.stringify(messages.filter((m) => m.role !== "system"));
}

describe("plugin hook semantics: beforeModelRequest", () => {
  it("appends a message the model sees in the next request", async () => {
    const { llm, submit } = await agentWith({
      async beforeModelRequest({ messages }) {
        return { messages: [...messages, { role: "user", content: "remember: Alpha" }] };
      },
    });
    llm.script({ text: "ok" });
    await submit("go");
    expect(messageTexts(llm)).toContain("remember: Alpha");
  });

  it("redacts request text and does not store it", async () => {
    const { llm, submit } = await agentWith({
      async beforeModelRequest({ messages }) {
        return {
          messages: messages.map((m) => ({
            ...m,
            content:
              typeof m.content === "string"
                ? m.content.replace("badword", "[redacted]")
                : m.content,
          })),
        };
      },
    });
    llm.script({ text: "ok" });
    await submit("badword text");
    expect(messageTexts(llm)).toContain("[redacted] text");
    expect(JSON.stringify(llm.requests[0].body)).not.toContain("badword");
  });

  it("round-trips messages unchanged so the request equals the no-hook one", async () => {
    const { llm, submit } = await agentWith({
      async beforeModelRequest({ messages }) {
        return { messages };
      },
    });
    llm.script({ text: "ok" });
    await submit("go");
    const withHook = conversationMessages(llm);

    const { llm: llm2, submit: submit2 } = await agentWith();
    llm2.script({ text: "ok" });
    await submit2("go");
    const withoutHook = conversationMessages(llm2);

    expect(withHook).toBe(withoutHook);
  });

  it("round-trips a tool-result message with its tool metadata", async () => {
    const seen: { role: string; toolName?: string; timestamp?: number }[] = [];
    const { llm, submit } = await agentWith({
      async beforeModelRequest({ messages }) {
        for (const m of messages) {
          if (m.role === "toolResult") {
            seen.push({
              role: m.role,
              toolName: (m as { toolName?: string }).toolName,
              timestamp: (m as { timestamp?: number }).timestamp,
            });
          }
        }
        return { messages };
      },
    });
    llm.script({ toolCall: { name: "echo", args: { text: "hi" } } }, { text: "ok" });
    await submit("go");

    const toolResult = seen.at(-1);
    expect(toolResult).toMatchObject({ role: "toolResult", toolName: "echo" });
    expect(typeof toolResult!.timestamp).toBe("number");

    const secondMessages = (recorded: FakeLlm): string => {
      const req = recorded.requests[1];
      if (!req) return "";
      const messages = (req.body.messages ?? []) as { role: string }[];
      return JSON.stringify(messages.filter((m) => m.role !== "system"));
    };
    const withHook = secondMessages(llm);

    const { llm: llm2, submit: submit2 } = await agentWith();
    llm2.script({ toolCall: { name: "echo", args: { text: "hi" } } }, { text: "ok" });
    await submit2("go");
    expect(withHook).toBe(secondMessages(llm2));
  });

  it("delivers every assistant response with usage to afterModelResponse", async () => {
    const seen: { text: string; usage?: unknown }[] = [];
    const { llm, submit } = await agentWith({
      async afterModelResponse({ message, usage }) {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        seen.push({ text, usage });
      },
    });
    llm.script({ text: "hello there", usage: { input: 3, output: 5 } });
    await submit("go");
    expect(seen.some((s) => s.text === "hello there")).toBe(true);
  });

  it("onAnswer returning continue once makes the run continue and then end", async () => {
    let continueUsed = false;
    const { llm, submit } = await agentWith({
      async onAnswer() {
        if (!continueUsed) {
          continueUsed = true;
          return { continue: "and?" };
        }
        return undefined;
      },
    });
    llm.script({ text: "first" }, { text: "second" });
    await submit("go");
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1].body)).toContain("and?");
    expect(continueUsed).toBe(true);
  });

  it("a throwing afterModelResponse is logged and the run answers normally", async () => {
    const { submit } = await agentWith({
      async afterModelResponse() {
        throw new Error("bad audit");
      },
    });
    const answer = await submit("go");
    expect(answer).toContain("ok");
  });
});
