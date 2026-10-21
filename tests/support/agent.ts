// Shared test support: tmp storage, faux models registered under the agent's
// model provider id, and agents that are stopped after each test.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_PROVIDER_ID, startAgent } from "@reework/core";
import type { AgentDefinition, RunningAgent, StartAgentOptions } from "@reework/core";

/** The API token every test agent is started with. */
export const TEST_TOKEN = "test-token";
process.env.REEWORK_API_TOKEN = TEST_TOKEN;

/** Headers carrying the test API token. */
export const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

/** `agent.app` with the API token added to every request. */
export function authedApp(agent: { app: RunningAgent["app"] }) {
  return {
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", authHeaders.authorization);
      return agent.app.request(path, { ...init, headers });
    },
  };
}

export function tmpStorage(): string {
  return join(mkdtempSync(join(tmpdir(), "reework-")), "agent.sqlite");
}

/** Faux models under the provider id `startAgent` selects, for `modelId`. */
export function fauxModels(modelId = "m1") {
  const faux = fauxProvider({ provider: MODEL_PROVIDER_ID, models: [{ id: modelId }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    respond: (steps: FauxResponseStep[]) => faux.setResponses(steps),
    append: (steps: FauxResponseStep[]) => faux.appendResponses(steps),
  };
}

export function testDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    model: {
      provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "REEWORK_TEST_LLM_KEY" },
      modelId: "m1",
    },
    plugins: [],
    channels: [],
    mission: { role: "You are a test agent." },
    ...overrides,
  };
}

const running: RunningAgent[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running
      .pop()!
      .stop()
      .catch(() => {});
  }
});

/**
 * Start an agent that is stopped automatically after the current test. Uses
 * faux models unless `models` is given — pass `models: undefined` explicitly to
 * use the definition's real custom endpoint.
 */
export async function startTestAgent(
  def: AgentDefinition,
  options: Partial<StartAgentOptions> = {},
): Promise<RunningAgent> {
  const models = "models" in options ? options.models : fauxModels(def.model.modelId).models;
  const agent = await startAgent(def, { storagePath: tmpStorage(), ...options, models });
  running.push(agent);
  return agent;
}

/** Forget an agent the test stopped itself (so afterEach does not stop it twice). */
export function untrack(agent: RunningAgent): void {
  const i = running.indexOf(agent);
  if (i >= 0) running.splice(i, 1);
}
