import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "@reework/core";
import type { AgentDefinition, PluginModels } from "@reework/core";
import { startTestAgent, text, waitFor } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";

const running: TestAgent[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((agent) => agent.dispose()));
});

function definition(extra?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "outside-runs",
    model: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "conv" },
    models: {
      fast: { provider: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }, modelId: "f" },
    },
    plugins: [],
    channels: [],
    mission: { role: "r" },
    ...extra,
  };
}

describe("named models outside a run", () => {
  it("a loop started in setup calls a declared model after setup returned", async () => {
    const answers: string[] = [];
    let kept: PluginModels | undefined;
    const digest = definePlugin(
      "digest",
      () => ({
        async setup(ctx) {
          // Kept for later: a background loop calls the model after setup returned.
          kept = ctx.models;
        },
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: digest, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("first summary"), text("second summary")]);

    answers.push((await kept!.complete("fast", { messages: "summarize" })).text);
    answers.push((await kept!.complete("fast", { messages: "summarize again" })).text);

    expect(answers).toEqual(["first summary", "second summary"]);
  });

  it("a route handler calls a declared model", async () => {
    const summarize = definePlugin(
      "summarize",
      () => ({
        routes(app, ctx) {
          app.post("/run", async (c) => {
            const result = await ctx.models.complete("fast", { messages: "summarize" });
            return c.json({ text: result.text });
          });
        },
      }),
      { models: ["fast"] },
    );
    const test = await startTestAgent(definition({ plugins: [{ plugin: summarize, config: {} }] }));
    running.push(test);
    test.model.named.fast.respond([text("route summary")]);

    const response = await test.agent.app.request("/plugins/summarize/run", {
      method: "POST",
      headers: { authorization: `Bearer ${test.token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "route summary" });
  });

  it("refuses a model the plugin did not declare, from setup and from routes", async () => {
    const errors: string[] = [];
    const sneaky = definePlugin("sneaky", () => ({
      async setup(ctx) {
        await ctx.models
          .complete("fast", { messages: "x" })
          .catch((error: Error) => errors.push(`setup: ${error.message}`));
      },
      routes(app, ctx) {
        app.post("/run", async (c) => {
          const message = await ctx.models.complete("fast", { messages: "x" }).then(
            () => "called",
            (error: Error) => error.message,
          );
          return c.json({ message });
        });
      },
    }));
    const test = await startTestAgent(definition({ plugins: [{ plugin: sneaky, config: {} }] }));
    running.push(test);

    const response = await test.agent.app.request("/plugins/sneaky/run", {
      method: "POST",
      headers: { authorization: `Bearer ${test.token}` },
    });

    await waitFor(() => errors.length === 1);
    expect(errors[0]).toMatch(/setup: plugin "sneaky" did not request model "fast"/);
    expect((await response.json()) as { message: string }).toEqual({
      message: 'plugin "sneaky" did not request model "fast"',
    });
  });
});
