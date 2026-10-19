import { describe, expect, it } from "vitest";
import { decideGateAnswer } from "@reework/tui";
import type { Proposal } from "@reework/types";

describe("the TUI's gate-answer decision", () => {
  it("answers with an offered option when the input is a single matching option id", () => {
    const proposals: Proposal[] = [
      {
        id: "gate-1",
        conversationId: "1",
        title: "Apply rollback?",
        options: [{ id: "rollback", label: "Roll back" }],
        acceptFreeForm: true,
        createdAt: 0,
      },
    ];

    expect(decideGateAnswer("rollback", proposals)).toEqual({
      kind: "option",
      proposalId: "gate-1",
      optionId: "rollback",
    });
  });

  it("gives a free-form instruction to the open gate when the input is not a matching option", () => {
    const proposals: Proposal[] = [
      {
        id: "gate-1",
        conversationId: "1",
        title: "Apply rollback?",
        options: [{ id: "rollback", label: "Roll back" }],
        acceptFreeForm: true,
        createdAt: 0,
      },
    ];

    expect(decideGateAnswer("hold off for now", proposals)).toEqual({
      kind: "instruction",
      proposalId: "gate-1",
      instruction: "hold off for now",
    });
  });

  it("returns null when no gate is open, so the input is sent as a message", () => {
    expect(decideGateAnswer("hello", [])).toBeNull();
  });
});
