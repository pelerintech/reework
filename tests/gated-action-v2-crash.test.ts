import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { definePlugin, gatedAction } from "@reework/core";
import { settleGate, engineOf } from "@reework/core/internal";

import {
  fauxModels,
  startTestAgent,
  testDefinition,
  tmpStorage,
  untrack,
} from "./support/agent.ts";
import { eventually } from "./support/wait.ts";

describe("a gated action across a restart mid-gate", () => {
  it("runs with the original arguments and resumes the agent after the restart", async () => {
    const storagePath = tmpStorage();
    const runs: unknown[] = [];
    const plugin = definePlugin("ops", () => ({
      tools: [
        gatedAction({
          name: "restart",
          parameters: Type.Object({ target: Type.String() }),
          gate: (args) => ({
            title: `Restart ${args.target}?`,
            options: [{ id: "go", label: "Go" }],
          }),
          async run(_ctx, _decision, args) {
            runs.push(args);
            return `restarted ${args.target}`;
          },
        }),
      ],
    }));
    const def = testDefinition({ plugins: [{ plugin, config: {} }] });

    const faux1 = fauxModels();
    faux1.respond([
      fauxAssistantMessage([fauxToolCall("restart", { target: "worker-3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("asked"),
    ]);
    const first = await startTestAgent(def, { storagePath, models: faux1.models });
    const { id } = await first.host.createConversation();
    await first.host.submitInput(id, "restart worker-3", { wait: true });
    const [proposal] = await first.host.listProposals();
    untrack(first);
    await first.stop();

    const faux2 = fauxModels();
    faux2.respond([fauxAssistantMessage("worker-3 is back")]);
    const second = await startTestAgent(def, { storagePath, models: faux2.models });
    await settleGate(engineOf(second), {
      proposalId: proposal.id,
      selectedOption: "go",
      instruction: null,
    });

    await eventually(async () =>
      JSON.stringify(await second.host.readConversation(id)).includes("worker-3 is back"),
    );
    expect(runs).toEqual([{ target: "worker-3" }]);
    expect(JSON.stringify((await second.host.readConversation(id)).entries)).toContain(
      "restarted worker-3",
    );
  });
});
