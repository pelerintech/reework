// Spike: what pi-durable 1.3.0 actually does for the hook semantics the reework
// hook design assumes. Internal (raw pi-durable extensions). Change any failing
// expectation to pi-durable's real behavior; the facade then enforces the design.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ENGINE_TEST_MODELS } from "./model-setup.js";
import { CONTEXT, Engine, installHITL } from "@reework/core/internal";

const open: Engine[] = [];
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-"));
  return join(dir, "session.sqlite");
}
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()!
      .close()
      .catch(() => {});
});

interface SpikeOpts {
  readonly block?: boolean;
  readonly throwAfter?: boolean;
}

/** A tool plugin and a hook extension, installed before the engine opens. */
function setup(events: string[], opts: SpikeOpts = {}) {
  const reg = createRegistry();
  installHITL(reg);
  reg.install(
    defineExtension({
      name: "tools",
      tools: [
        defineTool({
          name: "echo",
          description: "Echo.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
          async execute(args) {
            return {
              output: [{ type: "text", text: `echo:${(args as { text?: string }).text}` }],
            };
          },
        }),
      ],
    }),
  );
  reg.install(
    defineExtension({
      name: "hooks",
      hooks: [
        hook(ToolTask, {
          beforeTool(call) {
            events.push(`beforeTool:${call.name}`);
            if (opts.block && call.name === "echo") return { block: "no" };
            return {};
          },
          afterTool(call) {
            events.push(`afterTool:${call.name}`);
            return {};
          },
        }),
        hook(GenerationTask, {
          beforeRequest({ messages }) {
            events.push("beforeRequest");
            return { messages };
          },
          afterResponse() {
            events.push("afterResponse");
            if (opts.throwAfter) throw new Error("boom-after");
          },
          onYield(): undefined {
            events.push("onYield");
            return undefined;
          },
        }),
      ],
    }),
  );
  return reg;
}

async function runOnce(events: string[], opts: SpikeOpts = {}): Promise<void> {
  const models = ENGINE_TEST_MODELS();
  models.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const engine = await Engine.open({
    storagePath: tmpPath(),
    models: models.models,
    registry: setup(events, opts),
  });
  open.push(engine);
  const root = await engine.root();
  const submission = await root.submit({ type: "input", content: "go" }, CONTEXT);
  await submission.wait(CONTEXT);
}

describe("pi-durable hook semantics (spike)", () => {
  it("runs beforeTool and afterTool for a normal call, in order", async () => {
    const events: string[] = [];
    await runOnce(events);
    expect(events).toContain("beforeTool:echo");
    expect(events).toContain("afterTool:echo");
    expect(events.indexOf("beforeTool:echo")).toBeLessThan(events.indexOf("afterTool:echo"));
    expect(events).toContain("beforeRequest");
    expect(events).toContain("afterResponse");
    expect(events).toContain("onYield");
  });

  it("does NOT reach afterTool for a blocked call", async () => {
    const events: string[] = [];
    await runOnce(events, { block: true });
    // Spike result: pi-durable does not run afterTool for a call beforeTool blocked.
    expect(events.filter((e) => e === "beforeTool:echo")).toHaveLength(1);
    expect(events).not.toContain("afterTool:echo");
  });

  it("does NOT fail the run when afterResponse throws", async () => {
    const events: string[] = [];
    const models = ENGINE_TEST_MODELS();
    models.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const engine = await Engine.open({
      storagePath: tmpPath(),
      models: models.models,
      registry: setup(events, { throwAfter: true }),
    });
    open.push(engine);
    const root = await engine.root();
    const submission = await root.submit({ type: "input", content: "go" }, CONTEXT);
    const settled = await submission.wait(CONTEXT);
    // Spike result: a throwing afterResponse does not fail the run; it completes.
    expect(events).toContain("afterResponse");
    expect(settled.status).toBe("done");
  });
});
