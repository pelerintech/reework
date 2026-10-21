import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, gatedAction } from "@reework/core";
import {
  authHeaders,
  fauxModels,
  startTestAgent,
  testDefinition,
  untrack,
} from "./support/agent.ts";

function firstFrame(url: string): Promise<{ kind: string } & Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: authHeaders });
    socket.once("message", (data) => {
      resolve(JSON.parse((data as Buffer).toString("utf8")));
      socket.close();
    });
    socket.once("error", reject);
  });
}

describe("listen", () => {
  it("serves REST and WebSocket on a real port until stopped", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    const { id } = await agent.host.createConversation();
    const frame = await firstFrame(`ws://127.0.0.1:${port}/conversations/${id}/ws`);
    expect(frame.kind).toBe("snapshot");

    untrack(agent);
    await agent.stop();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it("starts the stream with a snapshot of the conversation's history and open proposals", async () => {
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("I asked for approval."),
    ]);
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({ name: "act", gate: { title: "Restart the worker?" }, run: async () => "ok" }),
      ],
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { port } = await agent.listen(0);
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "check the worker", { wait: true });

    const frame = await firstFrame(`ws://127.0.0.1:${port}/conversations/${id}/ws`);

    expect(frame.kind).toBe("snapshot");
    const text = JSON.stringify(frame.messages);
    expect(text).toContain("check the worker");
    expect(text).toContain("I asked for approval.");
    expect((frame.proposals as { title: string }[]).map((p) => p.title)).toEqual([
      "Restart the worker?",
    ]);
  });
});
