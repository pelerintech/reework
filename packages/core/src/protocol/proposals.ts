import { defineDoc } from "@earendil-works/pi-durable";
import type { Proposal, ProposalAttachment } from "@reework/types";
import type { GateAudience } from "@reework/types";
import type { Engine } from "../engine.ts";
import { CONTEXT } from "../engine.ts";
import { GateDecisionDoc, notifyProposalOpen } from "../hitl/gate.ts";
import type { SettledProposal } from "../hitl/gate.ts";

/** A proposal as recorded durably, with its open/settled status. */
export type OpenProposal = {
  id: string;
  conversationId: string;
  title: string;
  description?: string;
  options: { id: string; label: string; description?: string }[];
  attachments?: ProposalAttachment[];
  acceptFreeForm: boolean;
  /** Who may decide; absent on proposals stored before audiences existed (read as `human`). */
  audience?: GateAudience;
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

/** Subscribe (in-process) to proposals this engine opens. Returns an unsubscribe fn. */
export function onProposalOpen(engine: Engine, listener: (proposal: Proposal) => void): () => void {
  engine.hitl.listeners.add(listener);
  return () => engine.hitl.listeners.delete(listener);
}

/** Record an opened proposal as durable and open. */
export async function publishProposal(engine: Engine, proposal: Proposal): Promise<void> {
  await engine.commit(async (tx) => {
    const doc = (await tx.doc(ProposalsDoc)) as { proposals: OpenProposal[] };
    if (!doc.proposals.some((p) => p.id === proposal.id)) {
      doc.proposals.push({ ...proposal, status: "open" });
    }
  });
  notifyProposalOpen(engine.hitl, proposal);
}

/** Subscribe (in-process) to proposals settled by a decision. Returns an unsubscribe fn. */
export function onProposalSettled(
  engine: Engine,
  listener: (settled: SettledProposal) => void,
): () => void {
  engine.hitl.settledListeners.add(listener);
  return () => engine.hitl.settledListeners.delete(listener);
}

/** Return the currently-open proposals. */
export async function listOpenProposals(engine: Engine): Promise<Proposal[]> {
  const doc = await engine.harness.snapshot(ProposalsDoc, CONTEXT);
  return (doc?.proposals ?? [])
    .filter((p) => p.status === "open")
    .map(({ status: _status, ...rest }) => ({ ...rest, audience: rest.audience ?? "human" }));
}

/**
 * Return the settled proposals, each carrying the decision that settled it and
 * who decided (read from the durable decision store).
 */
export async function listSettledProposals(engine: Engine): Promise<Proposal[]> {
  const doc = await engine.harness.snapshot(ProposalsDoc, CONTEXT);
  const settled: Proposal[] = [];
  for (const record of doc?.proposals ?? []) {
    if (record.status !== "settled") continue;
    const { status: _status, ...proposal } = record;
    const decision = (await engine.harness.snapshot(GateDecisionDoc, record.id, CONTEXT))?.decision;
    settled.push({
      ...proposal,
      audience: proposal.audience ?? "human",
      ...(decision === null || decision === undefined
        ? {}
        : {
            decision,
            ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy }),
          }),
    });
  }
  return settled;
}
