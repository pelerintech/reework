import { defineDoc } from "@earendil-works/pi-durable";
import type { Proposal } from "@reework/types";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";

/** A proposal as recorded durably, with its open/settled status. */
export type OpenProposal = {
  id: string;
  conversationId: string;
  title: string;
  description?: string;
  options: { id: string; label: string; description?: string }[];
  acceptFreeForm: boolean;
  createdAt: number;
  status: "open" | "settled";
};

/**
 * Durable, session-scoped store of every proposal the engine has opened. Both
 * the network and the in-process (channel) surface read open proposals from
 * here, and `settleGate` marks a proposal settled so it drops off the open
 * list.
 */
export const ProposalsDoc = defineDoc<{ proposals: OpenProposal[] }>({
  kind: "rework.proposals",
  version: 1,
  scope: "session",
  initial: () => ({ proposals: [] }),
});

/** In-process listeners that observe opened proposals (the channel-facing stream). */
const proposalListeners = new Set<(proposal: Proposal) => void>();

/** Subscribe (in-process) to newly opened proposals. Returns an unsubscribe fn. */
export function onProposalOpen(listener: (proposal: Proposal) => void): () => void {
  proposalListeners.add(listener);
  return () => proposalListeners.delete(listener);
}

/** Notify in-process listeners that a proposal opened. */
export function notifyProposalOpen(proposal: Proposal): void {
  for (const listener of proposalListeners) {
    listener(proposal);
  }
}

/** Record an opened proposal as durable and open. */
export async function publishProposal(engine: Engine, proposal: Proposal): Promise<void> {
  await engine.commit(async (tx) => {
    const doc = (await tx.doc(ProposalsDoc)) as { proposals: OpenProposal[] };
    if (!doc.proposals.some((p) => p.id === proposal.id)) {
      doc.proposals.push({ ...proposal, status: "open" });
    }
  });
  notifyProposalOpen(proposal);
}

/** Mark a proposal settled so it leaves the open list. */
export async function markProposalSettled(engine: Engine, proposalId: string): Promise<void> {
  await engine.commit(async (tx) => {
    const doc = (await tx.doc(ProposalsDoc)) as { proposals: OpenProposal[] };
    const found = doc.proposals.find((p) => p.id === proposalId);
    if (found) {
      found.status = "settled";
    }
  });
}

/** Return the currently-open proposals. */
export async function listOpenProposals(engine: Engine): Promise<Proposal[]> {
  const doc = await engine.harness.snapshot(ProposalsDoc, CONTEXT);
  return (doc?.proposals ?? [])
    .filter((p) => p.status === "open")
    .map(({ status: _status, ...rest }) => rest);
}
