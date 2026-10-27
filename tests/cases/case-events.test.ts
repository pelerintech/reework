// A watching surface sees the case in the snapshot and follows case writes live.
import { describe, expect, it } from "vitest";
import { createClient } from "@reework/client";
import type { AgentEvent } from "@reework/types";
import { startTestAgent, text, toolCall, waitFor } from "@reework/core/testing";
import { testDefinition } from "../support/agent.ts";

describe("case events on the conversation stream", () => {
  it("carries the case in the snapshot and announces case writes", async () => {
    const test = await startTestAgent(testDefinition());
    const { port, close } = await test.agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: test.token });
    const { id } = await test.agent.host.createConversation();
    const other = await test.agent.host.createConversation();

    const frames: unknown[] = [];
    const events: AgentEvent[] = [];
    const watch = await client.watch(id, (frame) => {
      frames.push(frame);
      if (frame.kind === "events") events.push(...frame.events);
    });
    const otherEvents: AgentEvent[] = [];
    const otherWatch = await client.watch(other.id, (frame) => {
      if (frame.kind === "events") otherEvents.push(...frame.events);
    });

    const snapshot = await waitFor(() => {
      const frame = frames.find(
        (f): f is { kind: "snapshot"; case?: unknown } =>
          typeof f === "object" && f !== null && (f as { kind?: unknown }).kind === "snapshot",
      );
      return frame?.case ? frame : undefined;
    });
    expect(snapshot.case).toMatchObject({ id, status: "open", priority: "normal" });

    await test.agent.host.updateCase(id, { stage: "triaged" });
    const fromHost = await waitFor(
      () =>
        events.find(
          (e) => e.kind === "case_updated" && e.conversationId === id && e.case.stage === "triaged",
        ),
      { timeoutMs: 1500 },
    );
    expect(fromHost.kind).toBe("case_updated");

    test.model.respond([toolCall("update_case", { stage: "diagnosed" }), text("done")]);
    await test.agent.host.submitInput(id, "keep the case current", { wait: true });
    const fromModel = await waitFor(
      () =>
        events.find(
          (e) =>
            e.kind === "case_updated" && e.conversationId === id && e.case.stage === "diagnosed",
        ),
      { timeoutMs: 1500 },
    );
    expect(fromModel.kind).toBe("case_updated");

    expect(otherEvents.filter((e) => e.kind === "case_updated")).toEqual([]);

    watch.close();
    otherWatch.close();
    await close();
    await test.dispose();
  });
});
