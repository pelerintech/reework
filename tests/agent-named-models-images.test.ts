import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineTool, Type } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { startAgent } from "@reework/core";
import { startFakeLlm } from "./support/fake-llm.ts";
import { tmpStorage } from "./support/agent.ts";
import type { FakeLlm } from "./support/fake-llm.ts";
import { eventually } from "./support/wait.ts";

const running: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length)
    await running
      .pop()!
      .dispose()
      .catch(() => {});
});

const IMAGE_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function imageTool(modelName: string, outcome: string[]) {
  return definePlugin(
    "si",
    () => ({
      tools: [
        defineTool({
          name: "si",
          description: "send image",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            try {
              const r = await ctx.models.complete(modelName, {
                messages: [
                  {
                    role: "user",
                    content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
                  },
                ],
              });
              return `ok:${r.text}`;
            } catch (error) {
              outcome.push((error as Error).message);
              return `err:${(error as Error).message}`;
            }
          },
        }),
      ],
    }),
    { models: [modelName] },
  );
}

async function startWith(
  modelName: string,
  named: AgentDefinition["models"],
  llm: FakeLlm,
): Promise<FakeLlm> {
  const llmConv = await startFakeLlm();
  process.env["K"] = "k";
  const outcome: string[] = [];
  const plugin = imageTool(modelName, outcome);
  const def: AgentDefinition = {
    name: "nm",
    model: { provider: { baseUrl: llmConv.url, apiKeyEnv: "K" }, modelId: "m1" },
    models: named,
    plugins: [{ plugin, config: {} }],
    channels: [],
    mission: { role: "r" },
  };
  const agent = await startAgent(def, { storagePath: tmpStorage(), auth: { token: "t" } });
  running.push({ dispose: () => agent.stop() });
  const { id } = await agent.host.createConversation();
  llmConv.script({ toolCall: { name: "si", args: {} } }, { text: "done" });
  llm.script({ text: "seen" });
  await agent.host.submitInput(id, "go", { wait: true });
  return llm;
}

describe("named model image input", () => {
  it("an image-capable model carries the image on the wire (openai-completions)", async () => {
    const llmVision = await startFakeLlm();
    await startWith(
      "vision",
      {
        vision: {
          provider: { baseUrl: llmVision.url, apiKeyEnv: "K", api: "openai-completions" },
          modelId: "v",
          input: ["text", "image"],
        },
      },
      llmVision,
    );
    await eventually(() => llmVision.requests.length >= 1);
    expect(llmVision.requests.length).toBe(1);
    const body = JSON.stringify(llmVision.requests[0].body);
    expect(body).toMatch(/image|base64|image_url/i);
  });

  it("a text-only model rejects an image before any request is made", async () => {
    const llmFast = await startFakeLlm();
    await startWith(
      "fast",
      { fast: { provider: { baseUrl: llmFast.url, apiKeyEnv: "K" }, modelId: "f" } },
      llmFast,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(llmFast.requests.length).toBe(0);
  });
});
