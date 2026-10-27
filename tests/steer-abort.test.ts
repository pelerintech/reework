import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, defineTool, gatedAction, listOpenProposals } from "@reework/core";
import { engineOf } from "@reework/core/internal";
import { authHeaders, fauxModels, startTestAgent, testDefinition } from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

/** A tool that blocks until released (or the run is aborted). */
function slowTool() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  const tool = defineTool({
    name: "slow",
    description: "Takes a while.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, ctx) {
      started = true;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        void held.then(resolve);
      });
      return "slow done";
    },
  });
  return { tool, release, started: () => started };
}

const post = (
  app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  path: string,
  body: object = {},
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });

describe("operator control of a running conversation", () => {
  it("takes a steering message into the current run", async () => {
    const slow = slowTool();
    const seen: string[] = [];
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("final");
      },
    ]);
    const plugin = definePlugin("slow", () => ({ tools: [slow.tool] }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();

    await post(agent.app, `/conversations/${id}/messages`, { content: "start" });
    await eventually(() => slow.started());
    const steer = await post(agent.app, `/conversations/${id}/messages`, {
      content: "STEER-TEXT",
      mode: "steer",
    });
    expect(steer.status).toBe(202);
    slow.release();

    await eventually(async () =>
      JSON.stringify(await agent.host.readConversation(id)).includes("final"),
    );
    expect(seen[0]).toContain("STEER-TEXT");
  });

  it("aborts the current run without closing open gates", async () => {
    const slow = slowTool();
    const faux = fauxModels();
    faux.respond([
      fauxAssistantMessage([fauxToolCall("act", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("never"),
    ]);
    const plugin = definePlugin("ops", () => ({
      tools: [
        slow.tool,
        gatedAction({ name: "act", gate: { title: "Act?" }, run: async () => "acted" }),
      ],
    }));
    const agent = await startTestAgent(testDefinition({ plugins: [{ plugin, config: {} }] }), {
      models: faux.models,
    });
    const { id } = await agent.host.createConversation();

    await post(agent.app, `/conversations/${id}/messages`, { content: "start" });
    await eventually(() => slow.started());
    const res = await post(agent.app, `/conversations/${id}/abort`);
    expect(res.status).toBe(200);

    const read = JSON.stringify(await agent.host.readConversation(id));
    expect(read).not.toContain("never");
    const open = await listOpenProposals(engineOf(agent));
    expect(open.map((p) => p.title)).toEqual(["Act?"]);
  });
});
