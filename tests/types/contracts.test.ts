import { describe, expect, it } from "vitest";
import type { AgentEvent, Channel, GateDecision, Proposal } from "@reework/types";
import { isAgentEvent, isChannel, isGateDecision, isProposal } from "@reework/types";

describe("shared types contracts", () => {
  it("exposes the agent/stream event types used by the server and channels", () => {
    const event: AgentEvent = {
      kind: "message_update",
      conversationId: "conv-1",
      timestamp: 1,
      messageId: "m1",
      text: "hello",
    };
    expect(isAgentEvent(event)).toBe(true);
    expect(isAgentEvent({ kind: "nope" })).toBe(false);
  });

  it("defines a gate decision record supporting selectedOption and/or instruction", () => {
    const option: GateDecision = { proposalId: "p1", selectedOption: "refund", instruction: null };
    const freeform: GateDecision = {
      proposalId: "p1",
      selectedOption: null,
      instruction: "Just pay it",
    };
    const both: GateDecision = {
      proposalId: "p1",
      selectedOption: "refund",
      instruction: "and refund shipping",
    };
    expect(isGateDecision(option)).toBe(true);
    expect(isGateDecision(freeform)).toBe(true);
    expect(isGateDecision(both)).toBe(true);
    expect(isGateDecision({})).toBe(false);
  });

  it("defines the proposal surface", () => {
    const proposal: Proposal = {
      id: "p1",
      conversationId: "conv-1",
      title: "Approve refund",
      audience: "human",
      options: [{ id: "refund", label: "Refund" }],
      acceptFreeForm: true,
      createdAt: 1,
    };
    expect(isProposal(proposal)).toBe(true);
    expect(isProposal({ title: "x" })).toBe(false);
  });

  it("defines the Channel contract with separate REST and WS surfaces", () => {
    const channel: Channel = {
      id: "web",
      rest: {
        sendMessage: async () => ({ conversationId: "conv-1", result: "ok" }),
        getConversation: async () => ({ id: "conv-1", entries: [] }),
      },
      ws: {
        watchEvents: async () => ({
          snapshot: { events: [] },
          start: () => {},
        }),
      },
    };
    expect(isChannel(channel)).toBe(true);
    expect(isChannel({ id: "web" })).toBe(false);
  });
});
