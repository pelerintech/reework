// The TUI's state layer: pure protocol logic under the Ink view, so it can be
// tested without a terminal.
import type { ReeworkClient } from "@reework/client";
import type { Author, Case, Proposal } from "@reework/types";
import { decideGateAnswer } from "./answer.ts";

export interface StartState {
  /** Every case, in inbox order: needing a human first, then open, then waiting, then closed. */
  readonly cases: readonly Case[];
  /** Open proposals across every conversation. */
  readonly inbox: readonly Proposal[];
  /** Whether closed cases are shown (`:closed`). */
  readonly closed: boolean;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Who the operator is: the TUI speaks as a human, named by `USER` when it is set. */
export function operatorAuthor(): Author {
  const name = process.env.USER;
  return { kind: "human", ...(name ? { name } : {}) };
}

/** Inbox order: needsHuman first (any status), then open by priority/due, then waiting; closed last. */
export function orderCases(cases: readonly Case[], showClosed: boolean): Case[] {
  const rank = (c: Case) =>
    c.needsHuman ? 0 : c.status === "open" ? 1 : c.status === "waiting" ? 2 : 3;
  const due = (c: Case) => c.dueAt ?? Number.POSITIVE_INFINITY;
  return cases
    .filter((c) => showClosed || c.status !== "closed")
    .slice()
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if ((PRIORITY_RANK[a.priority] ?? 9) !== (PRIORITY_RANK[b.priority] ?? 9)) {
        return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      }
      if (due(a) !== due(b)) return due(a) - due(b);
      return b.updatedAt - a.updatedAt;
    });
}

/** What the TUI shows first: every case in inbox order, and the open proposals. */
export async function loadStartState(
  client: ReeworkClient,
  options: { closed?: boolean } = {},
): Promise<StartState> {
  const [cases, inbox] = await Promise.all([client.listCases(), client.listProposals()]);
  return {
    cases: orderCases(cases, options.closed ?? false),
    inbox: [...inbox].sort((a, b) => a.createdAt - b.createdAt),
    closed: options.closed ?? false,
  };
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
      decidedBy: operatorAuthor(),
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
  const { submissionId } = await client.submit(conversationId, text, { from: operatorAuthor() });
  return { submissionId };
}
