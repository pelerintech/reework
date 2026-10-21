import { describe, expect, it } from "vitest";
import { authedApp, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

describe("custom routes", () => {
  it("are mounted with the in-process host and handle their own auth", async () => {
    const agent = await startTestAgent(
      testDefinition({
        routes: (app, host) => {
          app.post("/hooks/ping", async (c) => {
            const { key } = await c.req.json<{ key: string }>();
            const conversation = await host.createConversation({ key });
            await host.submitInput(conversation.id, `ping ${key}`, { requestId: key });
            return c.json({ conversationId: conversation.id }, 202);
          });
        },
      }),
    );
    const ping = () =>
      agent.app.request("/hooks/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "alert-42" }),
      });

    const first = await ping();
    const second = await ping();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = ((await first.json()) as { conversationId: string }).conversationId;
    const b = ((await second.json()) as { conversationId: string }).conversationId;
    expect(b).toBe(a);

    const listed = (await (await authedApp(agent).request("/conversations")).json()) as {
      conversations: { id: string; key?: string }[];
    };
    expect(listed.conversations).toEqual([expect.objectContaining({ id: a, key: "alert-42" })]);
    await eventually(async () => (await agent.host.readConversation(a)).entries.length >= 2);
    const inputs = (await agent.host.readConversation(a)).entries.filter(
      (e) => e.kind === "pi.user",
    );
    expect(inputs).toHaveLength(1);
  });
});
