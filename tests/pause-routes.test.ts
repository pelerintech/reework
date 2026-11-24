// Pause, resume and status are token-guarded routes over the agent's durable
// intake state; /health stays a liveness probe.
import { describe, expect, it } from "vitest";
import { authHeaders, startTestAgent, testDefinition } from "./support/agent.ts";

describe("the pause routes", () => {
  it("pauses, reports status and resumes behind the token", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    const call = (method: string, path: string, headers: Record<string, string> = authHeaders) =>
      fetch(url(path), { method, headers });

    const paused = await call("POST", "/pause");
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as {
      paused: boolean;
      pausedAt: number;
      activeRuns: number;
      heldInputs: number;
    };
    expect(pausedBody).toMatchObject({ paused: true, activeRuns: 0, heldInputs: 0 });
    expect(typeof pausedBody.pausedAt).toBe("number");

    const status = await call("GET", "/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(pausedBody);

    const again = await call("POST", "/pause");
    expect(await again.json()).toEqual(pausedBody);

    const resumed = await call("POST", "/resume");
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as {
      paused: boolean;
      resumedAt: number;
      heldInputs: number;
    };
    expect(resumedBody).toMatchObject({ paused: false, heldInputs: 0 });
    expect(typeof resumedBody.resumedAt).toBe("number");

    const twice = await call("POST", "/resume");
    expect(await twice.json()).toEqual(resumedBody);
  });

  it("holds input submitted through the API and admits it on resume", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    const { id } = await agent.host.createConversation();
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;

    await fetch(url("/pause"), { method: "POST", headers: authHeaders });
    const submitted = await fetch(url(`/conversations/${id}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ content: "held input" }),
    });
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({ held: true });
    const held = (await (await fetch(url("/status"), { headers: authHeaders })).json()) as {
      heldInputs: number;
    };
    expect(held.heldInputs).toBe(1);

    const resumed = await fetch(url("/resume"), { method: "POST", headers: authHeaders });
    expect(await resumed.json()).toMatchObject({ paused: false, heldInputs: 0 });
  });

  it("answers 401 without the token and leaves the state unchanged", async () => {
    const agent = await startTestAgent(testDefinition());
    const { port } = await agent.listen(0);
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    const unauthorized = async (
      method: string,
      path: string,
      headers: Record<string, string> = {},
    ) => {
      const res = await fetch(url(path), { method, headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    };

    await unauthorized("POST", "/pause");
    await unauthorized("POST", "/pause", { authorization: "Bearer wrong" });
    await unauthorized("GET", "/status");
    await unauthorized("GET", "/status", { authorization: "Bearer wrong" });
    await unauthorized("POST", "/resume");
    await unauthorized("POST", "/resume", { authorization: "Bearer wrong" });
    expect(agent.paused).toBe(false);

    const health = await fetch(url("/health"));
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody).toMatchObject({ ok: true });
    expect(healthBody).not.toHaveProperty("paused");
  });
});
