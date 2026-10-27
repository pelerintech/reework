// The status bar says who the agent is and what it is doing right now.
import { describe, expect, it } from "vitest";
import { Type, defineTool, definePlugin } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { startTui } from "./support/tui.tsx";

function definition(gate: Promise<void>): AgentDefinition {
  const plugin = definePlugin("ops", () => ({
    tools: [
      defineTool({
        name: "run_suite",
        description: "Runs the test suite",
        parameters: Type.Object({}),
        execute: async () => {
          await gate;
          return "green";
        },
      }),
      defineTool({
        name: "flaky",
        description: "Fails",
        parameters: Type.Object({}),
        execute: async () => {
          throw new Error("backend down");
        },
      }),
    ],
  }));
  return {
    name: "status-agent",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "You run suites." },
  };
}

const elapsedOf = (frame: string) => {
  const match = /running run_suite (\d+)(ms|s)/.exec(frame);
  if (!match) return -1;
  return match[2] === "s" ? Number(match[1]) * 1000 : Number(match[1]);
};

describe("the TUI status bar", () => {
  it("names the agent, shows the running tool with a growing time, then idle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tui = await startTui(definition(gate));
    await tui.agent.host.createConversation({ key: "ci" });
    await tui.waitForFrame("status-agent");
    await tui.send(":1");
    await tui.waitForFrame("idle");

    tui.model.respond([toolCall("run_suite"), toolCall("flaky"), text("suite is green")]);
    await tui.send("run the suite");
    const first = elapsedOf(await tui.waitForFrame(/running run_suite \d+/));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(elapsedOf(tui.frame())).toBeGreaterThan(first);

    release();
    const done = await tui.waitForFrame((f) => f.includes("suite is green") && f.includes("idle"));
    expect(done).toMatch(/flaky\s+failed/);
    expect(done).toMatch(/run_suite\s+done/);
  });
});
