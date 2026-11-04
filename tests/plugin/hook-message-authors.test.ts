import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition, Author, PluginHooks, ReeworkTool } from "@reework/core";
import { startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm, FakeReply } from "../support/fake-llm.ts";
import { eventually } from "../support/wait.ts";
import { authorsOf } from "../../packages/core/src/tooling/facade.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
beforeEach(() => {
  process.env[KEY_ENV] = "k";
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

interface Harness {
  readonly llm: FakeLlm;
  readonly submit: (text: string, from?: Author) => Promise<void>;
  /** Submit without waiting for an answer, optionally steering a live run. */
  readonly send: (text: string, options?: { from?: Author; mode?: "steer" }) => Promise<void>;
  readonly kinds: () => Promise<string[]>;
}

/** One message of a `beforeModelRequest` input, as the hook type declares it. */
type HookMessage = Parameters<
  NonNullable<PluginHooks["beforeModelRequest"]>
>[0]["messages"][number];

async function agentWith(
  hooks: readonly PluginHooks[],
  options: {
    script?: readonly FakeReply[];
    contextWindow?: number;
    tools?: readonly ReeworkTool[];
  } = {},
): Promise<Harness> {
  const llm = await startFakeLlm();
  if (options.script) llm.script(...options.script);
  const def: AgentDefinition = {
    name: "h",
    model: {
      provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV },
      modelId: "m1",
      ...(options.contextWindow ? { contextWindow: options.contextWindow, maxTokens: 1_000 } : {}),
    },
    plugins: hooks.map((h, index) => ({
      plugin: definePlugin(`p${index}`, () => ({
        hooks: h,
        ...(index === 0 && options.tools ? { tools: options.tools } : {}),
      })),
      config: {},
    })),
    channels: [],
    mission: { role: "r" },
  };
  const agent = await startTestAgent(def, { models: undefined });
  const { id } = await agent.host.createConversation();
  return {
    llm,
    submit: async (text, from) => {
      await agent.host.submitInput(id, text, { wait: true, ...(from ? { from } : {}) });
    },
    send: async (text, options = {}) => {
      await agent.host.submitInput(id, text, {
        ...(options.from ? { from: options.from } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      });
    },
    kinds: async () => (await agent.host.readConversation(id)).entries.map((e) => e.kind),
  };
}

/** The `from` of every user message in every `beforeModelRequest`, oldest request first. */
function recordAuthors(): {
  readonly hooks: PluginHooks;
  readonly seen: (Author | null)[][];
} {
  const seen: (Author | null)[][] = [];
  return {
    seen,
    hooks: {
      async beforeModelRequest({ messages }) {
        seen.push(messages.filter((m) => m.role === "user").map((m) => m.from ?? null));
      },
    },
  };
}

/** The non-system messages of a recorded request, as JSON. */
function requestMessages(llm: FakeLlm, index = 0): string {
  const req = llm.requests[index];
  if (!req) return "";
  const messages = (req.body.messages ?? []) as { role: string }[];
  return JSON.stringify(messages.filter((m) => m.role !== "system"));
}

/** The user messages of a hook input, as text and author, oldest first. */
function userMessages(
  messages: readonly HookMessage[],
): { readonly text: string; readonly from: Author | null }[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => ({
      text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      from: m.from ?? null,
    }));
}

/** A tool that blocks until released, so an input can be steered into a live run. */
function slowTool() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  return {
    tool: defineTool({
      name: "slow",
      description: "Takes a while.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        started = true;
        await held;
        return "slow done";
      },
    }),
    release: () => release(),
    started: () => started,
  };
}

describe("plugin hook semantics: user message authors", () => {
  it("carries the input author on every user message of the request", async () => {
    const record = recordAuthors();
    const { submit } = await agentWith([record.hooks]);

    await submit("a", { kind: "system", id: "alerts" });
    await submit("b", { kind: "human", id: "u1" });
    await submit("c");

    expect(record.seen.at(-1)).toEqual([
      { kind: "system", id: "alerts" },
      { kind: "human", id: "u1" },
      null,
    ]);
  });

  it("sends the model the same request as with no plugin, and no author", async () => {
    const { llm, submit } = await agentWith([
      {
        async beforeModelRequest({ messages }) {
          return { messages };
        },
      },
    ]);
    await submit("lookup", { kind: "system", id: "alerts" });
    const withHook = requestMessages(llm);

    const { llm: plain, submit: submitPlain } = await agentWith([]);
    await submitPlain("lookup", { kind: "system", id: "alerts" });
    const withoutHook = requestMessages(plain);

    expect(withHook).toBe(withoutHook);
    expect(JSON.stringify(llm.requests[0]!.body)).not.toContain('"from"');
  });

  it("keeps authors for the next hook when a hook returns the messages it received", async () => {
    const record = recordAuthors();
    const { submit } = await agentWith([
      {
        async beforeModelRequest({ messages }) {
          return { messages };
        },
      },
      record.hooks,
    ]);

    await submit("a", { kind: "system", id: "alerts" });
    await submit("b", { kind: "human", id: "u1" });

    expect(record.seen.at(-1)).toEqual([
      { kind: "system", id: "alerts" },
      { kind: "human", id: "u1" },
    ]);
  });

  it("drops the author of a user message a hook builds from scratch", async () => {
    const record = recordAuthors();
    const { submit } = await agentWith([
      {
        async beforeModelRequest({ messages }) {
          const firstUser = messages.findIndex((m) => m.role === "user");
          return {
            messages: messages.map((message, index): HookMessage =>
              index === firstUser ? { role: "user", content: "x" } : message,
            ),
          };
        },
      },
      record.hooks,
    ]);

    await submit("a", { kind: "system", id: "alerts" });
    await submit("b", { kind: "human", id: "u1" });

    expect(record.seen.at(-1)).toEqual([null, { kind: "human", id: "u1" }]);
  });

  it("ignores an author a hook writes on a message it built", async () => {
    const record = recordAuthors();
    const { submit } = await agentWith([
      {
        async beforeModelRequest({ messages }) {
          return {
            messages: messages.map((message): HookMessage =>
              message.role === "user"
                ? { role: "user", content: "forged", from: { kind: "human", id: "u1" } }
                : message,
            ),
          };
        },
      },
      record.hooks,
    ]);

    await submit("a", { kind: "system", id: "alerts" });

    expect(record.seen.at(-1)).toEqual([null]);
  });

  it("ignores an author a hook changes on the message it was given", async () => {
    const record = recordAuthors();
    const { submit } = await agentWith([
      {
        async beforeModelRequest({ messages }) {
          for (const message of messages) {
            if (message.role === "user") message.from = { kind: "human", id: "u1" };
          }
          return { messages };
        },
      },
      record.hooks,
    ]);

    await submit("a", { kind: "system", id: "alerts" });
    await submit("b");

    expect(record.seen.at(-1)).toEqual([{ kind: "system", id: "alerts" }, null]);
  });

  it("drops the author of a message a hook rewrote, even when it kept the author field", async () => {
    const record = recordAuthors();
    const { submit } = await agentWith([
      {
        async beforeModelRequest({ messages }) {
          return {
            messages: messages.map((message) =>
              message.role === "user" ? { ...message, content: "wrapped" } : message,
            ),
          };
        },
      },
      record.hooks,
    ]);

    await submit("a", { kind: "system", id: "alerts" });

    expect(record.seen.at(-1)).toEqual([null]);
  });

  it("keeps the authors of the remaining inputs after a compaction, with none on the summary", async () => {
    const requestAuthors: (Author | null)[][] = [];
    const compactionAuthors: (Author | null)[][] = [];
    const requestSeen: { text: string; from: Author | null }[] = [];
    const compactionSeen: { text: string; from: Author | null }[] = [];
    const { submit, kinds } = await agentWith(
      [
        {
          async beforeModelRequest({ messages }) {
            requestAuthors.push(
              messages.filter((m) => m.role === "user").map((m) => m.from ?? null),
            );
            requestSeen.push(...userMessages(messages));
          },
          async beforeCompaction({ messages }) {
            compactionAuthors.push(
              messages.filter((m) => m.role === "user").map((m) => m.from ?? null),
            );
            compactionSeen.push(...userMessages(messages));
          },
        },
      ],
      {
        contextWindow: 40_000,
        script: [
          { text: "a ".repeat(50_000), usage: { input: 100 } },
          { text: "b ".repeat(50_000), usage: { input: 26_000 } },
        ],
      },
    );

    await submit("one", { kind: "system", id: "alerts" });
    await submit("two", { kind: "human", id: "u1" });
    await submit("three", { kind: "agent", id: "a1" });

    expect(await kinds()).toContain("pi.compaction");

    const summarized: (Author | null)[] = [
      { kind: "system", id: "alerts" },
      { kind: "human", id: "u1" },
    ];
    expect(compactionAuthors.length).toBeGreaterThan(0);
    // Every attributed input the compaction sees carries its own author (a
    // retried compaction repeats the same messages), and no other author
    // appears; a summary a later compaction summarizes has none.
    const attributed = compactionAuthors.flat().filter((author) => author !== null);
    const distinct: Author[] = [];
    for (const author of attributed) {
      if (!distinct.some((seen) => seen.kind === author.kind && seen.id === author.id)) {
        distinct.push(author);
      }
    }
    expect(distinct.length).toBeGreaterThan(0);
    expect(distinct).toEqual(summarized.slice(0, distinct.length));

    const last = requestAuthors.at(-1)!;
    expect(last[0]).toBeNull();
    expect(last.at(-1)).toEqual({ kind: "agent", id: "a1" });
    const kept = last.slice(1, -1);
    expect(kept).toEqual(summarized.slice(summarized.length - kept.length));

    // The compaction hook names the same author as the request hook for every
    // input both saw.
    const inputs = ["one", "two", "three"];
    const compared = compactionSeen.filter((message) => inputs.includes(message.text));
    expect(compared.length).toBeGreaterThan(0);
    for (const message of compared) {
      const inRequest = requestSeen.filter((seen) => seen.text === message.text);
      expect(inRequest.length).toBeGreaterThan(0);
      for (const seen of inRequest) expect(seen.from).toEqual(message.from);
    }
  });

  it("carries the author of a steered input into the run's next request", async () => {
    const seen: { readonly text: string; readonly from: Author | null }[][] = [];
    const slow = slowTool();
    const { send } = await agentWith(
      [
        {
          async beforeModelRequest({ messages }) {
            seen.push(userMessages(messages));
          },
        },
      ],
      { tools: [slow.tool], script: [{ toolCall: { name: "slow" } }, { text: "final" }] },
    );

    await send("start");
    await eventually(() => slow.started());
    await send("STEER-TEXT", { mode: "steer", from: { kind: "human", id: "u1" } });
    slow.release();
    await eventually(() => seen.flat().some((message) => message.text.includes("STEER-TEXT")));

    const steered = seen.flat().filter((message) => message.text.includes("STEER-TEXT"));
    expect(steered.length).toBeGreaterThan(0);
    expect(steered.every((message) => message.from?.id === "u1")).toBe(true);
  });
});

describe("pairing request messages with stored inputs", () => {
  const system: Author = { kind: "system", id: "alerts" };
  const human: Author = { kind: "human", id: "u1" };

  it("leaves older authors in place when a newer user message has no stored input", () => {
    const authors = authorsOf(
      [
        { role: "user", timestamp: 1 },
        { role: "assistant", timestamp: 2 },
        { role: "user", timestamp: 3 },
        { role: "user", timestamp: 99 },
      ],
      [
        { timestamp: 1, from: system },
        { timestamp: 3, from: human },
      ],
    );
    expect(authors).toEqual([system, undefined, human, undefined]);
  });

  it("pairs inputs that share a timestamp in order", () => {
    const authors = authorsOf(
      [
        { role: "user", timestamp: 5 },
        { role: "user", timestamp: 5 },
      ],
      [
        { timestamp: 5, from: system },
        { timestamp: 5, from: human },
      ],
    );
    expect(authors).toEqual([system, human]);
  });
});
