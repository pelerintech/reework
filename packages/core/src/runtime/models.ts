import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import type { AgentDefinition, AgentModel, AgentModelApi } from "../agent-definition.ts";
import type { SecretsRuntime } from "./secrets.ts";

/** Exactly one of `apiKeyEnv` / `apiKey` per model, and every named secret declared. */
export function validateModelKeys(agent: AgentDefinition): void {
  const check = (label: string, model: AgentModel): void => {
    const { apiKeyEnv, apiKey } = model.provider;
    const hasEnv = apiKeyEnv !== undefined;
    const hasSecret = apiKey !== undefined;
    if (hasEnv === hasSecret) {
      throw new Error(`model "${label}" must set exactly one of apiKeyEnv or apiKey`);
    }
    if (apiKey !== undefined) {
      const name = apiKey.secret;
      if (!name) throw new Error(`model "${label}" must name a secret in apiKey`);
      if (!agent.secrets || !Object.hasOwn(agent.secrets, name)) {
        throw new Error(
          `model "${label}" names secret "${name}", which the agent does not declare`,
        );
      }
    }
  };
  check("main", agent.model);
  for (const [name, model] of Object.entries(agent.models ?? {})) check(name, model);
}

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
export function customModels(
  model: AgentModel,
  named: Record<string, AgentModel> = {},
  secrets?: SecretsRuntime,
): MutableModels {
  const models = createModels();
  models.setProvider(agentModelProvider(MODEL_PROVIDER_ID, model, secrets));
  for (const [name, def] of Object.entries(named)) {
    if (name === "main") {
      throw new Error(`model name "main" is reserved; it names the conversation model`);
    }
    models.setProvider(agentModelProvider(`reework.model.${name}`, def, secrets));
  }
  return models;
}

/** One provider for a model (the agent's own, or a named model). */
function agentModelProvider(
  providerId: string,
  model: AgentModel,
  secrets?: SecretsRuntime,
): ReturnType<typeof createProvider> {
  const { baseUrl } = model.provider;
  const api = model.provider.api ?? "openai-completions";
  const { contextWindow, maxTokens } = modelLimits(model);
  return createProvider({
    id: providerId,
    name: providerId,
    baseUrl,
    auth: { apiKey: modelApiKeyAuth(model, secrets) },
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        api,
        provider: providerId,
        baseUrl,
        input: (model.input ?? ["text"]) as ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
      },
    ],
    api: { [api]: limitRequests(STREAMS[api](), model.maxConcurrentRequests) },
  });
}

/** How the provider authenticates: an env variable or a declared secret. */
function modelApiKeyAuth(model: AgentModel, secrets?: SecretsRuntime) {
  const { apiKeyEnv, apiKey } = model.provider;
  if (apiKeyEnv !== undefined) {
    if (!process.env[apiKeyEnv]) {
      throw new Error(`model API key variable ${apiKeyEnv} is not set`);
    }
    return {
      name: `API key from ${apiKeyEnv}`,
      resolve: async () => {
        const key = process.env[apiKeyEnv];
        return key ? { auth: { apiKey: key }, source: apiKeyEnv } : undefined;
      },
    };
  }
  if (apiKey !== undefined) {
    const secret = apiKey.secret;
    return {
      name: `API key from secret ${secret}`,
      resolve: async () => {
        if (!secrets) throw new Error(`secret "${secret}" is not wired in this build`);
        return { auth: { apiKey: secrets.resolve(secret) }, source: `secret:${secret}` };
      },
    };
  }
  throw new Error(`model provider ${model.provider.baseUrl} has no API key source`);
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** The model's limits, defaulted and checked: positive integers, output below the window. */
function modelLimits(model: AgentModel): { contextWindow: number; maxTokens: number } {
  const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = model.maxTokens ?? DEFAULT_MAX_TOKENS;
  for (const [field, value] of [
    ["contextWindow", contextWindow],
    ["maxTokens", maxTokens],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`model.${field} must be a positive integer (got ${value})`);
    }
  }
  if (maxTokens >= contextWindow) {
    throw new Error(
      `model.maxTokens (${maxTokens}) must be below model.contextWindow (${contextWindow})`,
    );
  }
  return { contextWindow, maxTokens };
}

/**
 * Bound the requests in flight through `streams`. The event stream is returned at once;
 * the real request starts when a slot is free and gives it back when it ends — done,
 * failed or aborted. An aborted waiter still starts, so the provider reports the abort.
 */
function limitRequests(streams: ProviderStreams, limit: number | undefined): ProviderStreams {
  if (limit === undefined) return streams;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`model.maxConcurrentRequests must be a positive integer (got ${limit})`);
  }
  const slots = semaphore(limit);
  const limited = <O extends { signal?: AbortSignal }>(
    start: (model: never, context: never, options?: O) => ReturnType<ProviderStreams["stream"]>,
  ) =>
    ((model: never, context: never, options?: O) => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        const release = await slots.acquire(options?.signal);
        try {
          const inner = start(model, context, options);
          for await (const event of inner) out.push(event);
          out.end(await inner.result());
        } finally {
          release();
        }
      })();
      return out;
    }) as never;
  return {
    ...streams,
    stream: limited((model, context, options) => streams.stream(model, context, options)),
    streamSimple: limited((model, context, options) =>
      streams.streamSimple(model, context, options),
    ),
  };
}

/** A FIFO counting semaphore; an aborted waiter is let through at once. */
function semaphore(size: number) {
  let free = size;
  const queue: (() => void)[] = [];
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else free += 1;
  };
  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (free > 0) {
        free -= 1;
        return Promise.resolve(once(release));
      }
      return new Promise((resolve) => {
        const grant = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(once(release));
        };
        // Aborted while waiting: leave the queue without taking a slot.
        const onAbort = () => {
          const index = queue.indexOf(grant);
          if (index >= 0) queue.splice(index, 1);
          resolve(() => {});
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(grant);
      });
    },
  };
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
