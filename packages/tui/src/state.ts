// The TUI's state layer: pure protocol logic under the Ink view, so it can be
// tested without a terminal.
import type { ConversationListing, ReeworkClient } from "@reework/client";
import type { Proposal } from "@reework/types";
import { decideGateAnswer } from "./answer.ts";

export interface StartState {
  /** Open proposals across every conversation: what is waiting on the operator. */
  readonly inbox: readonly Proposal[];
  readonly conversations: readonly ConversationListing[];
}

/** What the TUI shows first: the inbox and every conversation. */
export async function loadStartState(client: ReeworkClient): Promise<StartState> {
  const [inbox, conversations] = await Promise.all([
    client.listProposals(),
    client.listConversations(),
  ]);
  return { inbox: [...inbox].sort((a, b) => a.createdAt - b.createdAt), conversations };
}

export type ProposalAnswer =
  | { readonly kind: "option"; readonly optionId: string }
  | { readonly kind: "instruction"; readonly instruction: string };

/**
 * Answer one proposal with what the operator typed: an offered option id picks
 * that option; anything else is a free-form instruction when the gate accepts
 * one. The decision is posted to the proposal's own conversation. Returns how
 * the input was read, or `null` when it answers nothing.
 */
export async function answerProposal(
  client: ReeworkClient,
  proposal: Proposal,
  input: string,
): Promise<ProposalAnswer | null> {
  const answer = decideGateAnswer(input, [proposal]);
  if (!answer) return null;
  await client.decide(
    {
      proposalId: proposal.id,
      selectedOption: answer.kind === "option" ? answer.optionId : null,
      instruction: answer.kind === "instruction" ? answer.instruction : null,
    },
    { conversationId: proposal.conversationId },
  );
  return answer.kind === "option"
    ? { kind: "option", optionId: answer.optionId }
    : { kind: "instruction", instruction: answer.instruction };
}

/**
 * Send the operator's input to a conversation without waiting for the run: the
 * answer arrives on the conversation's event stream, so the TUI stays usable.
 */
export async function sendToAgent(
  client: ReeworkClient,
  conversationId: string,
  text: string,
): Promise<{ submissionId: string }> {
  const { submissionId } = await client.submit(conversationId, text);
  return { submissionId };
}
