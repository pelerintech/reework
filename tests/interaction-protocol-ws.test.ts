import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@reework/types";
import { authHeaders, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

describe("interaction protocol: a client streams live agent events over WS", () => {
  it("delivers a conversation's live AgentEvents in the shared vocabulary", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("streamed over ws")]);
    const agent = await startTestAgent(testDefinition(), { models: faux.models });
    const { port } = await agent.listen(0);
    const { id } = await agent.host.createConversation();

    const events: AgentEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/conversations/${id}/ws`, {
      headers: authHeaders,
    });
    ws.on("message", (data) => {
      const parsed = JSON.parse((data as Buffer).toString("utf8")) as {
        kind: string;
        events?: AgentEvent[];
      };
      if (parsed.kind === "events" && Array.isArray(parsed.events)) events.push(...parsed.events);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    await agent.host.submitInput(id, "stream it", { wait: true });
    await eventually(() => events.some((e) => e.kind === "run_end"));

    for (const event of events) {
      expect(typeof event.kind).toBe("string");
      expect(event.conversationId).toBe(id);
      expect(typeof event.timestamp).toBe("number");
    }
    ws.close();
  });
});
