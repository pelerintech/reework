// `ctx.models.embed` calls a named model's OpenAI-compatible embeddings
// endpoint directly, reports its usage like completions, refuses protocols
// without embeddings, and honours `beforeModelCall`.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, ModelEmbedResult } from "@reework/core";
import { startFakeEmbeddings } from "../support/fake-embeddings.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import { startTestAgent, testDefinition } from "../support/agent.ts";

const LLM_ENV = "REEWORK_TEST_EMBED_LLM_KEY";
const EMBED_ENV = "REEWORK_TEST_EMBED_KEY";

afterEach(() => {
  delete process.env[LLM_ENV];
  delete process.env[EMBED_ENV];
});

function definition(
  llmUrl: string,
  embedUrl: string,
  plugins: AgentDefinition["plugins"],
): AgentDefinition {
  return testDefinition({
    name: "embed-agent",
    model: { provider: { baseUrl: llmUrl, apiKeyEnv: LLM_ENV }, modelId: "m1" },
    models: {
      embedder: {
        provider: { baseUrl: embedUrl, apiKeyEnv: EMBED_ENV },
        modelId: "text-embedding-3-small",
      },
    },
    plugins,
    mission: { role: "You are an embedding test agent." },
  });
}

describe("ctx.models.embed", () => {
  it("returns the named model's vectors and sends its model and input", async () => {
    const endpoint = await startFakeEmbeddings();
    endpoint.respond({
      embeddings: [
        [0.25, 0.5],
        [0.75, 1],
      ],
    });
    const llm = await startFakeLlm();
    process.env[LLM_ENV] = "llm-key";
    process.env[EMBED_ENV] = "embed-key";

    let seen: ModelEmbedResult | undefined;
    const embedder = definePlugin(
      "embedder",
      () => ({
        tools: [
          defineTool({
            name: "embed",
            description: "embed two passages",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              seen = await ctx.models.embed("embedder", ["a", "b"]);
              return "embedded";
            },
          }),
        ],
      }),
      { models: ["embedder"] },
    );

    const agent = await startTestAgent(
      definition(llm.url, endpoint.url, [{ plugin: embedder, config: {} }]),
      { models: undefined },
    );
    llm.script({ toolCall: { name: "embed" } }, { text: "done" });
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(seen?.embeddings).toEqual([
      [0.25, 0.5],
      [0.75, 1],
    ]);
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]).toMatchObject({
      path: "/v1/embeddings",
      model: "text-embedding-3-small",
      input: ["a", "b"],
    });
    expect(endpoint.requests[0]!.headers.authorization).toBe("Bearer embed-key");
  });
});
