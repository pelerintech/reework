import type { Proposal } from "@reework/types";

/** How an operator's input resolves against the open gates. */
export type GateAnswer =
  | { kind: "option"; proposalId: string; optionId: string }
  | { kind: "instruction"; proposalId: string; instruction: string };

/**
 * Decide how an operator's input should be handled given the open gates.
 * - If the input exactly names an offered option, answer that gate with the option.
 * - Else if a free-form gate is open, give the input as an instruction to it.
 * - Else `null`, so the input is sent to the agent as a message.
 */
export function decideGateAnswer(input: string, proposals: Proposal[]): GateAnswer | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  for (const proposal of proposals) {
    const option = proposal.options.find((o) => o.id === trimmed);
    if (option) {
      return { kind: "option", proposalId: proposal.id, optionId: option.id };
    }
  }

  const freeform = proposals.find((p) => p.acceptFreeForm);
  if (freeform) {
    return { kind: "instruction", proposalId: freeform.id, instruction: trimmed };
  }

  return null;
}
