import { Type, uuidv7 } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { GateAudience, GateDecision, Proposal, ProposalAttachment } from "@reework/types";
import { defineTool, markGatedTool, toolInternal } from "../tooling/facade.ts";
import type { ToolContext, ToolResult, ReeworkTool } from "../tooling/facade.ts";
import { onceInCommit } from "../tooling/once.ts";
import { GatedToolTask } from "./gate.ts";
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
  /** Who may decide this gate; absent means `human` (a built gate may raise it). */
  audience?: GateAudience;
  /** Evidence and proposed changes shown with the proposal. */
  attachments?: ProposalAttachment[];
}

/** What a gate builder knows about the call it is building a proposal for. */
export interface GatedActionGateContext {
  /** The conversation the gate opens in (e.g. to read that conversation's workspace). */
  readonly conversationId: string;
  readonly models: ToolContext["models"];
  readonly secrets: ToolContext["secrets"];
  readonly files: ToolContext["files"];
  readonly store: ToolContext["store"];
  readonly case: ToolContext["case"];
  /** Other cases, when the plugin declared `{ cases: true }`. */
  readonly cases?: ToolContext["cases"];
}

/** The reework context a gated action's `run` receives after the human decides. */
export interface GatedActionRunContext {
  readonly conversationId: string;
  readonly signal: AbortSignal;
  readonly models: ToolContext["models"];
  readonly secrets: ToolContext["secrets"];
  readonly files: ToolContext["files"];
  readonly store: ToolContext["store"];
  readonly case: ToolContext["case"];
  /** Other cases, when the plugin declared `{ cases: true }`. */
  readonly cases?: ToolContext["cases"];
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
  /** Who may decide when the gate does not set it; absent means `human`. */
  audience?: GateAudience;
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
): ReeworkTool<TParameters> {
  const parameters: TParameters =
    def.parameters ?? (Type.Object({}, { additionalProperties: false }) as unknown as TParameters);
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
    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const gate = await gateFor(args as Static<TParameters>, {
        conversationId: ctx.conversationId,
        models: ctx.models,
        secrets: ctx.secrets,
        files: ctx.files,
        store: ctx.store,
        case: ctx.case,
        ...(ctx.cases === undefined ? {} : { cases: ctx.cases }),
      });
      // A file attachment must belong to this conversation; a foreign file fails the gate
      // before any proposal opens. Valid attachments carry their record's name/type/size.
      const attachments = gate.attachments
        ? await Promise.all(
            gate.attachments.map(async (attachment) => {
              if (attachment.kind !== "file") return attachment;
              const { record } = await ctx.files.read(attachment.fileId);
              return {
                ...attachment,
                name: record.name,
                mimeType: record.mimeType,
                size: record.size,
              };
            }),
          )
        : undefined;
      const proposal: Proposal = {
        id: uuidv7(),
        conversationId: ctx.conversationId,
        title: gate.title,
        audience: def.audience ?? "human",
        ...(gate.description === undefined ? {} : { description: gate.description }),
        ...(attachments === undefined ? {} : { attachments }),
        options: gate.options ?? [],
        acceptFreeForm: gate.acceptFreeForm ?? false,
        createdAt: Date.now(),
      };

      const { api, context } = toolInternal(ctx);
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
              audience: proposal.audience,
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
        output: `Proposal "${proposal.title}" was sent to a human for a decision. The action has NOT been carried out yet — do not report it as done. When the human decides, the decision and the result will arrive as a new message.`,
      };
    },
  });
  return markGatedTool(tool, (ctx: GatedActionRunContext, decision: GateDecision, args: unknown) =>
    def.run(ctx, decision, args as Static<TParameters>),
  );
}
