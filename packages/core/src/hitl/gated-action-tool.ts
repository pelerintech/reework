import { Type, uuidv7 } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { GateDecision, Proposal, ProposalAttachment } from "@reework/types";
import { defineTool } from "../tooling/facade.ts";
import { onceInCommit } from "../tooling/once.ts";
import { GatedToolTask, markGated } from "./gate.ts";
import type { GatedActionRunContext } from "./gate.ts";
import { ProposalsDoc } from "../protocol/proposals.ts";
import type { OpenProposal } from "../protocol/proposals.ts";

/** The gate an action opens: what the human sees and how they can answer. */
export interface GatedActionGate {
  title: string;
  description?: string;
  /** Finite offered choices, each mapping to a branch. */
  options?: { id: string; label: string; description?: string }[];
  /** Whether the human may also give a free-form instruction. */
  acceptFreeForm?: boolean;
  /** Evidence and proposed changes shown with the proposal. */
  attachments?: ProposalAttachment[];
}

export type { GatedActionRunContext };

/** What a gate builder knows about the call it is building a proposal for. */
export interface GatedActionGateContext {
  /** The conversation the gate opens in (e.g. to read that conversation's workspace). */
  readonly conversationId: string;
}

export interface GatedActionDefinition<TParameters extends TSchema = TSchema> {
  /** Tool name the agent calls to invoke the gated action. */
  name: string;
  description?: string;
  /** The arguments the model passes; validated before the gate opens. Default: none. */
  parameters?: TParameters;
  /** The gate to open: fixed, or built (possibly asynchronously) from the call's arguments. */
  gate:
    | GatedActionGate
    | ((
        args: Static<TParameters>,
        ctx: GatedActionGateContext,
      ) => GatedActionGate | Promise<GatedActionGate>);
  /** Runs after the human decides, with the decision and the original arguments. */
  run(
    ctx: GatedActionRunContext,
    decision: GateDecision,
    args: Static<TParameters>,
  ): Promise<unknown>;
}

/**
 * The primary developer-facing gate surface: a callable tool that gates a
 * consequential action. When the agent invokes it, the tool records the
 * proposal and creates a `rework.gatedTool` task (a standalone durable action)
 * holding the arguments, and returns at once — so the suspended action does not
 * halt the agent. On the human's decision the task runs `run`.
 */
export function gatedAction<TParameters extends TSchema>(
  def: GatedActionDefinition<TParameters>,
): ToolRegistration {
  const parameters = def.parameters ?? Type.Object({}, { additionalProperties: false });
  const gateFor = async (
    args: Static<TParameters>,
    ctx: GatedActionGateContext,
  ): Promise<GatedActionGate> => (typeof def.gate === "function" ? def.gate(args, ctx) : def.gate);

  const tool = defineTool({
    name: def.name,
    description: def.description ?? (typeof def.gate === "function" ? def.name : def.gate.title),
    parameters,
    // Replay-safe: an interrupted call reruns after restart and finds its receipt
    // instead of reporting a failure the model would answer by opening a second gate.
    replay: "safe",
    execute: async (
      args,
      api: ToolExecutionApi,
      context,
    ): Promise<{ output: { type: "text"; text: string }[] }> => {
      const gate = await gateFor(args as Static<TParameters>, {
        conversationId: String(api.conversationId),
      });
      const proposal: Proposal = {
        id: uuidv7(),
        conversationId: String(api.conversationId),
        title: gate.title,
        ...(gate.description === undefined ? {} : { description: gate.description }),
        ...(gate.attachments === undefined ? {} : { attachments: gate.attachments }),
        options: gate.options ?? [],
        acceptFreeForm: gate.acceptFreeForm ?? false,
        createdAt: Date.now(),
      };

      await onceInCommit(api, context, async (tx) => {
        const doc = (await tx.doc(ProposalsDoc)) as { proposals: OpenProposal[] };
        doc.proposals.push({ ...proposal, status: "open" });
        await tx.createTask(
          GatedToolTask,
          {
            runKey: def.name,
            args: args as JsonValue,
            proposal: {
              id: proposal.id,
              title: proposal.title,
              options: proposal.options,
              acceptFreeForm: proposal.acceptFreeForm,
            },
            createdAt: proposal.createdAt,
          },
          {
            conversationId: api.conversationId,
            ownership: { kind: "conversation" },
            background: true,
          },
        );
        return proposal.id;
      });

      return {
        output: [
          {
            type: "text",
            text: `Proposal "${proposal.title}" was sent to a human for a decision. The action has NOT been carried out yet — do not report it as done. When the human decides, the decision and the result will arrive as a new message.`,
          },
        ],
      };
    },
  });
  return markGated(tool, (ctx, decision, args) =>
    def.run(ctx, decision, args as Static<TParameters>),
  );
}
