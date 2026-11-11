// A headless agent has no model: it serves routes and runs setup, refuses input
// that would start a run, and still settles gates and runs gated actions.
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import { Type, definePlugin, gatedAction, listOpenProposals, startAgent } from "@reework/core";
import type { AgentDefinition, RunningAgent } from "@reework/core";
import { text, toolCall, waitFor, waitForProposal } from "@reework/core/testing";
import { engineOf, settleGate } from "@reework/core/internal";
import {
  authedApp,
  fauxModels,
  startTestAgent,
  TEST_TOKEN,
  tmpStorage,
  untrack,
} from "../support/agent.ts";

const running: RunningAgent[] = [];
afterEach(async () => {
  while (running.length > 0) {
    await running
      .pop()!
      .stop()
      .catch(() => {});
  }
});

function definition(plugin: ReturnType<typeof definePlugin>): AgentDefinition {
  return {
    name: "headless-agent",
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You route work." },
  };
}

describe("headless agents", () => {
  it("refuses an HTTP submit with a 409 and the clear message", async () => {
    const agent = await startAgent(
      { name: "headless-http", plugins: [], channels: [], mission: { role: "Route work." } },
      { storagePath: tmpStorage(), auth: { token: TEST_TOKEN } },
    );
    running.push(agent);
    const { port, close } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    const { id } = await client.createConversation();
    const failure = await client.submit(id, "hello").then(
      () => undefined,
      (error: unknown) => error,
    );
    await close();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { status?: number }).status).toBe(409);
    expect((failure as Error).message).toContain("cannot start a run: no model configured");
  });

  it("answers a submit to an unknown conversation with 404 before the refusal", async () => {
    const agent = await startAgent(
      { name: "headless-unknown", plugins: [], channels: [], mission: { role: "Route work." } },
      { storagePath: tmpStorage(), auth: { token: TEST_TOKEN } },
    );
    running.push(agent);
    const { port, close } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    const failure = await client.submit("99999", "hello").then(
      () => undefined,
      (error: unknown) => error,
    );
    await close();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { status?: number }).status).toBe(404);
    expect((failure as Error).message).toContain("conversation_not_found");
  });

  it("serves routes and setup, refuses runs, and settles gates", async () => {
    const seen = { setup: false, runs: [] as unknown[] };
    const headless = definePlugin("headless", () => ({
      setup() {
        seen.setup = true;
      },
      routes(app) {
        app.get("/check", (c) => c.json({ ok: true }));
      },
      tools: [
        gatedAction({
          name: "approve",
          parameters: Type.Object({}),
          gate: { title: "Approve?", options: [{ id: "yes", label: "Yes" }] },
          async run(_ctx, decision) {
            seen.runs.push(decision);
            return "approved";
          },
        }),
      ],
    }));
    const storagePath = tmpStorage();
    const faux = fauxModels("m1");
    faux.respond([toolCall("approve"), text("waiting")]);
    const opener = await startTestAgent(
      {
        ...definition(headless),
        model: { provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "K" }, modelId: "m1" },
      },
      { storagePath, models: faux.models },
    );
    untrack(opener);
    const { id: openerId } = await opener.host.createConversation();
    await opener.host.submitInput(openerId, "open a gate");
    const proposal = await waitForProposal(opener.host, openerId);
    await opener.stop();

    const agent = await startAgent(definition(headless), {
      storagePath,
      auth: { token: TEST_TOKEN },
    });
    running.push(agent);

    expect(seen.setup).toBe(true);
    const response = await authedApp(agent).request("/plugins/headless/check");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const { id } = await agent.host.createConversation();
    const opened = await listOpenProposals(engineOf(agent));
    expect(opened).toHaveLength(1);
    await expect(agent.host.submitInput(id, "hello")).rejects.toThrow(
      /cannot start a run: no model configured/,
    );
    expect(await listOpenProposals(engineOf(agent))).toHaveLength(1);

    await settleGate(engineOf(agent), {
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
    });
    await waitFor(() => seen.runs.length === 1);
    expect(seen.runs[0]).toMatchObject({ selectedOption: "yes" });
  });
});
