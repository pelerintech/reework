import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { AgentModel, AgentModelApi } from "../agent-definition.ts";

/** Provider id under which the agent's model is registered and selected. */
export const MODEL_PROVIDER_ID = "reework.custom";

const STREAMS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
} satisfies Record<AgentModelApi, unknown>;

/**
 * A model catalog with one provider: the agent's custom endpoint. The API key
 * is read from `apiKeyEnv`, which must be set — checked here, before the
 * engine opens.
 */
export function customModels(model: AgentModel): MutableModels {
  const { baseUrl, apiKeyEnv } = model.provider;
  const api = model.provider.api ?? "openai-completions";
  if (!process.env[apiKeyEnv]) {
    throw new Error(`model API key variable ${apiKeyEnv} is not set`);
  }

  const provider = createProvider({
    id: MODEL_PROVIDER_ID,
    name: "Custom endpoint",
    baseUrl,
    auth: {
      apiKey: {
        name: `API key from ${apiKeyEnv}`,
        resolve: async () => {
          const key = process.env[apiKeyEnv];
          return key ? { auth: { apiKey: key }, source: apiKeyEnv } : undefined;
        },
      },
    },
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        api,
        provider: MODEL_PROVIDER_ID,
        baseUrl,
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    api: { [api]: STREAMS[api]() },
  });

  const models = createModels();
  models.setProvider(provider);
  return models;
}
