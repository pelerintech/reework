import { Type, uuidv7 } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { GateDecision, Proposal } from "@reework/types";
import { defineTool } from "../tooling/facade.ts";
import { GatedToolTask, registerGatedAction } from "./gate.ts";
import type { GatedActionRunContext } from "./gate.ts";
import { notifyProposalOpen, ProposalsDoc } from "../protocol/proposals.ts";
import type { OpenProposal } from "../protocol/proposals.ts";

/** The gate an action opens: what the human sees and how they can answer. */
export interface GatedActionGate {
  title: string;
  /** Finite offered choices, each mapping to a branch. */
  options?: { id: string; label: string }[];
  /** Whether the human may also give a free-form instruction. */
  acceptFreeForm?: boolean;
}

export type { GatedActionRunContext };

export interface GatedActionDefinition {
  /** Tool name the agent calls to invoke the gated action. */
  name: string;
  description?: string;
  gate: GatedActionGate;
  /** Runs after the human decides, branching on the chosen outcome. */
  run(ctx: GatedActionRunContext, decision: GateDecision): Promise<unknown>;
}

/**
 * The primary developer-facing gate surface: a callable tool that gates a
 * consequential action. When the agent invokes it, the tool opens a durable
 * gate by creating a `rework.gatedTool` task (a standalone durable action),
 * publishes the open proposal, and returns at once — so the suspending action
 * is its own task and does not halt the agent. On the human's decision the
 * durable action resumes and runs `run`, branching on the chosen outcome.
 */
export function gatedAction(def: GatedActionDefinition): ToolRegistration {
  registerGatedAction(def.name, (ctx, decision) => def.run(ctx, decision));
  const parameters = Type.Object({}, { additionalProperties: false });

  return defineTool({
    name: def.name,
    description: def.description ?? def.gate.title,
    parameters,
    execute: async (
      _args,
      api: ToolExecutionApi,
      context,
    ): Promise<{ output: { type: "text"; text: string }[] }> => {
      const proposalId = uuidv7();
      const proposal: Proposal = {
        id: proposalId,
        conversationId: String(api.conversationId),
        title: def.gate.title,
        options: def.gate.options ?? [],
        acceptFreeForm: def.gate.acceptFreeForm ?? false,
        createdAt: Date.now(),
      };

      await api.commit(async (tx) => {
        const doc = (await tx.doc(ProposalsDoc)) as { proposals: OpenProposal[] };
        doc.proposals.push({ ...proposal, status: "open" });
        await tx.createTask(
          GatedToolTask,
          {
            runKey: def.name,
            proposal: {
              id: proposalId,
              title: def.gate.title,
              options: def.gate.options ?? [],
              acceptFreeForm: def.gate.acceptFreeForm ?? false,
            },
          },
          {
            conversationId: api.conversationId,
            ownership: { kind: "conversation" },
            background: true,
          },
        );
      }, context);

      notifyProposalOpen(proposal);
      return {
        output: [{ type: "text", text: "Gated action opened; awaiting a human decision." }],
      };
    },
  });
}
