// The inbox is the case list: ordering, rows, :closed, the case header, and operator commands.
import { describe, expect, it } from "vitest";
import { definePlugin, gatedAction } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { KEYS, startTui } from "./support/tui.tsx";

const plugin = definePlugin("ops", () => ({
  tools: [
    gatedAction({
      name: "approve",
      gate: { title: "Approve?", options: [{ id: "yes", label: "Yes" }] },
      run: async () => "ok",
    }),
  ],
}));

const definition: AgentDefinition = {
  name: "cases-agent",
  model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "m1" },
  plugins: [{ plugin, config: {} }],
  channels: [],
  mission: { role: "You help." },
};

/** A case whose open proposal makes it need a human. */
async function needsHuman(tui: Awaited<ReturnType<typeof startTui>>, key: string) {
  tui.model.respond([toolCall("approve"), text("asked")]);
  const { id } = await tui.agent.host.createConversation({ key });
  await tui.agent.host.submitInput(id, "go", { wait: false });
  return id;
}

const at = (frame: string, token: string) => frame.indexOf(token);

describe("the TUI case inbox", () => {
  it("orders cases: needsHuman first, then open by priority, then waiting; closed only after :closed", async () => {
    const tui = await startTui(definition);
    const urgent = await needsHuman(tui, "urgent-case");
    await tui.agent.host.updateCase(urgent, { priority: "urgent" });
    const high = (await tui.agent.host.createConversation({ key: "high-case" })).id;
    await tui.agent.host.updateCase(high, { priority: "high" });
    const normal = (await tui.agent.host.createConversation({ key: "normal-case" })).id;
    const waiting = (await tui.agent.host.createConversation({ key: "waiting-case" })).id;
    await tui.agent.host.updateCase(waiting, { status: "waiting" });
    const closed = (await tui.agent.host.createConversation({ key: "closed-case" })).id;
    await tui.agent.host.updateCase(closed, { status: "closed" });

    const frame = await tui.waitForFrame("urgent-case");
    expect(at(frame, "urgent-case")).toBeLessThan(at(frame, "high-case"));
    expect(at(frame, "high-case")).toBeLessThan(at(frame, "normal-case"));
    expect(at(frame, "normal-case")).toBeLessThan(at(frame, "waiting-case"));
    expect(frame).not.toContain("closed-case");
    expect(normal).toBeTruthy();

    await tui.send(":closed");
    const withClosed = await tui.waitForFrame("closed-case");
    expect(at(withClosed, "waiting-case")).toBeLessThan(at(withClosed, "closed-case"));
  });

  it("shows a case header above its transcript", async () => {
    const tui = await startTui(definition);
    const { id } = await tui.agent.host.createConversation({ key: "header-case" });
    await tui.agent.host.updateCase(id, {
      title: "Broken build",
      stage: "triaged",
      priority: "high",
    });
    await tui.waitForFrame("Broken build");
    await tui.type(KEYS.enter);
    const frame = await tui.waitForFrame("Broken build");
    expect(frame).toContain("triaged");
    expect(frame).toContain("high");
  });

  it("acts on cases with :close, :wait, :reopen and :priority", async () => {
    const tui = await startTui(definition);
    const { id } = await tui.agent.host.createConversation({ key: "act-case" });
    await tui.waitForFrame("act-case");
    await tui.type(KEYS.enter);
    await tui.waitForFrame("conversation act-case");

    await tui.send(":close");
    await tui.waitForFrame("case closed");
    expect((await tui.agent.host.getCase(id))?.status).toBe("closed");
    await tui.send(":reopen");
    await tui.waitForFrame("case open");
    expect((await tui.agent.host.getCase(id))?.status).toBe("open");
    await tui.send(":wait");
    await tui.waitForFrame("case waiting");
    expect((await tui.agent.host.getCase(id))?.status).toBe("waiting");
    await tui.send(":priority high");
    await tui.waitForFrame("priority high");
    expect((await tui.agent.host.getCase(id))?.priority).toBe("high");
  });

  it("dismisses an open proposal with :dismiss", async () => {
    const tui = await startTui(definition);
    const id = await needsHuman(tui, "dismiss-case");
    await tui.waitForFrame("dismiss-case");
    await tui.type(KEYS.enter);
    await tui.waitForFrame("Approve?");
    await tui.send(":dismiss");
    await tui.waitForFrame("proposal dismissed");
    expect((await tui.agent.host.getCase(id))?.needsHuman).toBe(false);
  });
});

describe("the TUI case inbox rows", () => {
  it("puts a waiting low-priority case needing a human above an open urgent one", async () => {
    const tui = await startTui(definition);
    const waitingLow = await needsHuman(tui, "waiting-low");
    await tui.agent.host.updateCase(waitingLow, { status: "waiting", priority: "low" });
    const openUrgent = (await tui.agent.host.createConversation({ key: "open-urgent" })).id;
    await tui.agent.host.updateCase(openUrgent, { priority: "urgent" });

    const frame = await tui.waitForFrame("waiting-low");
    expect(at(frame, "waiting-low")).toBeLessThan(at(frame, "open-urgent"));
  });

  it("shows title, stage, priority, due date and open proposals on a row", async () => {
    const tui = await startTui(definition);
    const id = await needsHuman(tui, "row-case");
    const dueAt = Date.UTC(2031, 4, 6);
    await tui.agent.host.updateCase(id, {
      title: "Row title",
      stage: "triaged",
      priority: "high",
      dueAt,
    });

    const frame = await tui.waitForFrame("Row title");
    expect(frame).toContain("triaged");
    expect(frame).toContain("high");
    expect(frame).toContain("2031-05-06");
    expect(frame).toContain("1 proposal");
  });

  it("falls back to the key, then the id, when a case has no title", async () => {
    const tui = await startTui(definition);
    const keyed = (await tui.agent.host.createConversation({ key: "keyed-case" })).id;
    const unkeyed = (await tui.agent.host.createConversation()).id;

    const keyedFrame = await tui.waitForFrame("keyed-case");
    expect(keyedFrame).toContain("keyed-case");
    expect(keyedFrame).not.toContain(keyed);
    const idFrame = await tui.waitForFrame(unkeyed);
    expect(idFrame).toContain(unkeyed);
  });
});

describe("the TUI refuses an impossible close", () => {
  it("shows the refusal and leaves the case open", async () => {
    const tui = await startTui(definition);
    const id = await needsHuman(tui, "refuse-close");
    await tui.waitForFrame("refuse-close");
    await tui.type(KEYS.enter);
    await tui.waitForFrame("Approve?");

    await tui.send(":close");
    const frame = await tui.waitForFrame(/open\s+proposal/);
    expect(frame).toMatch(/open\s+proposal/);
    expect((await tui.agent.host.getCase(id)).status).not.toBe("closed");
  });
});
