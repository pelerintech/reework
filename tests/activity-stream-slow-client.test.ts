import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ActivityFrame } from "@reework/types";
import { activityWatcherCount } from "@reework/core/testing";
import { authHeaders, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

describe("the activity stream's slow-client policy", () => {
  it("closes an overflowing subscriber without blocking runs", async () => {
    const faux = fauxModels();
    faux.respond([fauxAssistantMessage("still runs answer")]);
    const agent = await startTestAgent(testDefinition(), {
      models: faux.models,
      activity: { maxBufferedBytes: 1 },
    });
    const { port } = await agent.listen(0);
    const conversation = await agent.host.createConversation();

    const socket = new WebSocket(`ws://127.0.0.1:${port}/activity/ws`, { headers: authHeaders });
    const frames: ActivityFrame[] = [];
    socket.on("message", (data) => {
      frames.push(JSON.parse((data as Buffer).toString("utf8")) as ActivityFrame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    while (frames.length === 0) await new Promise((done) => setTimeout(done, 10));
    expect(frames[0]!.kind).toBe("snapshot");
    expect(activityWatcherCount(agent)).toBe(1);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await agent.host.updateCase(conversation.id, { status: "waiting" });
    expect(await closed).toEqual({ code: 1008, reason: "slow consumer" });
    expect(activityWatcherCount(agent)).toBe(0);

    const result = await agent.host.submitInput(conversation.id, "still runs", { wait: true });
    expect(JSON.stringify(result.message)).toContain("still runs answer");
    const health = await agent.app.request("/health");
    expect(health.status).toBe(200);
  });
});
