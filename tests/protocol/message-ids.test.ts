// Streamed answers arrive as many `message_update` events; each must carry the id of
// its `message_start`, so a surface can assemble one message from them.
import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import type { AgentEvent } from "@reework/types";
import { scriptedModel, startTestAgent, text, waitFor, waitForIdle } from "@reework/core/testing";
import type { AgentDefinition } from "@reework/core";

const definition: AgentDefinition = {
  name: "streamer",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [],
  channels: [],
  mission: { role: "You answer at length." },
};

describe("streamed message ids", () => {
  it("gives every delta of an answer its message's id, and each answer its own id", async () => {
    const model = scriptedModel("m1", { tokensPerSecond: 100, tokenSize: { min: 2, max: 2 } });
    const long = (word: string) => Array.from({ length: 60 }, () => word).join(" ");
    model.respond([text(long("alpha")), text(long("beta"))]);
    const { agent, token, dispose } = await startTestAgent(definition, { models: model.models });
    const { port, close } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const { id } = await agent.host.createConversation();

    const events: AgentEvent[] = [];
    const watch = await client.watch(id, (frame) => {
      if (frame.kind === "events") events.push(...frame.events);
    });
    await agent.host.submitInput(id, "first", { wait: true });
    await agent.host.submitInput(id, "second", { wait: true });
    await waitForIdle(agent.host, id);
    await waitFor(() => events.filter((e) => e.kind === "message_start").length >= 4);

    // Assistant answers only: user inputs also start messages but carry no deltas.
    const byMessage = new Map<string, number>();
    let current: string | undefined;
    for (const event of events) {
      if (event.kind === "message_start") current = event.messageId;
      if (event.kind === "message_update") {
        expect(event.messageId).toBe(current);
        byMessage.set(event.messageId, (byMessage.get(event.messageId) ?? 0) + 1);
      }
    }
    const streamed = [...byMessage.entries()].filter(([, count]) => count > 1);
    expect(streamed).toHaveLength(2);
    expect(streamed[0][0]).not.toBe(streamed[1][0]);

    watch.close();
    await close();
    await dispose();
  });
});
