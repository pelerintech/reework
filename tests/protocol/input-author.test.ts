// Input attribution: every input can record who it is from, visible on the stored
// entry, in snapshots and the client view, while the model sees the text unchanged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import type { ReeworkClient } from "@reework/client";
import { defineAgent } from "@reework/core";
import type { Author, RunningAgent } from "@reework/core";
import { TEST_TOKEN, startTestAgent } from "../support/agent.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import type { FakeLlm } from "../support/fake-llm.ts";

const KEY_ENV = "REEWORK_TEST_LLM_KEY";
const BASE = "http://in-process.test";
const realFetch = globalThis.fetch;

/** A `fetch` that sends the agent's own URLs through `app.request` and everything else on. */
function fetchThroughApp(agent: RunningAgent, baseUrl: string): typeof fetch {
  const patched: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseUrl)) return realFetch(input, init);
    return Promise.resolve(agent.app.request(url.slice(baseUrl.length), init));
  };
  return patched;
}

interface Served {
  readonly llm: FakeLlm;
  readonly agent: RunningAgent;
  readonly client: ReeworkClient;
  readonly id: string;
}

describe("input attribution", () => {
  let served: Served | undefined;

  beforeEach(() => {
    process.env[KEY_ENV] = "k";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env[KEY_ENV];
  });

  async function start(): Promise<Served> {
    const llm = await startFakeLlm();
    const definition = defineAgent({
      name: "author-agent",
      model: { provider: { baseUrl: llm.url, apiKeyEnv: KEY_ENV }, modelId: "m1" },
      plugins: [],
      channels: [],
      mission: { role: "You answer." },
    });
    const agent = await startTestAgent(definition, { models: undefined });
    const { id } = await agent.host.createConversation();
    globalThis.fetch = fetchThroughApp(agent, BASE);
    served = { llm, agent, client: createClient({ baseUrl: BASE, token: TEST_TOKEN }), id };
    return served;
  }

  /** The user content the endpoint received last, from the last recorded request. */
  function lastUserContent(llm: FakeLlm): unknown {
    const request = llm.requests.at(-1);
    const messages = (request?.body.messages ?? []) as { role: string; content: unknown }[];
    return messages.filter((m) => m.role === "user").at(-1)?.content;
  }

  it("carries an author from the client through the snapshot, the transcript and the entry", async () => {
    const { llm, agent, client, id } = await start();
    llm.script({ text: "answer" });
    const from: Author = { kind: "system", id: "alerts" };

    await client.submit(id, "hello", { from, wait: true });

    const snapshot = await agent.host.snapshot(id);
    const message = snapshot.messages.find((m) => m.role === "user");
    expect(message?.from).toEqual(from);
    const item = snapshot.transcript.find((i) => i.type === "message" && i.role === "user");
    expect(item?.type === "message" ? item.from : undefined).toEqual(from);

    const read = await agent.host.readConversation(id);
    const entry = read.entries.find((e) => e.kind === "reework.input");
    expect(entry?.data).toEqual({ from });
    expect(lastUserContent(llm)).toBe("hello");
  });

  it("leaves input without an author unattributed, keeping the pi.user entry", async () => {
    const { llm, agent, client, id } = await start();
    llm.script({ text: "answer" });

    await client.submit(id, "hello", { wait: true });

    const snapshot = await agent.host.snapshot(id);
    expect(snapshot.messages.find((m) => m.role === "user")?.from).toBeUndefined();
    const read = await agent.host.readConversation(id);
    expect(read.entries.some((e) => e.kind === "pi.user")).toBe(true);
    expect(read.entries.some((e) => e.kind === "reework.input")).toBe(false);
  });

  it("carries an author from the host", async () => {
    const { llm, agent, id } = await start();
    llm.script({ text: "answer" });
    const from: Author = { kind: "human", name: "Ana" };

    await agent.host.submitInput(id, "x", { from, wait: true });

    const snapshot = await agent.host.snapshot(id);
    expect(snapshot.messages.find((m) => m.role === "user")?.from).toEqual(from);
  });

  it("keeps one message for a repeated request id, attributed once", async () => {
    const { llm, agent, client, id } = await start();
    llm.script({ text: "answer" });
    const from: Author = { kind: "system", id: "alerts" };

    await client.submit(id, "hello", { from, requestId: "r1", wait: true });
    await client.submit(id, "hello", { from, requestId: "r1", wait: true });

    const snapshot = await agent.host.snapshot(id);
    const users = snapshot.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.from).toEqual(from);
  });
});
