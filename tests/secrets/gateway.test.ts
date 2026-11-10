// The gateway backend keeps secret values out of the agent: fetch proxies through
// the gateway, raw reads obey the token, and model calls use the gateway's
// upstream path.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { fauxModels, startTestAgent, testDefinition } from "../support/agent.ts";
import { startFakeGateway } from "../support/fake-gateway.ts";
import { startFakeHttp } from "../support/fake-http.ts";
import { startFakeLlm } from "../support/fake-llm.ts";

const BOX_TOKEN = "REEWORK_TEST_BOX_TOKEN";

afterEach(() => {
  delete process.env[BOX_TOKEN];
});

describe("gateway backend: fetch and raw", () => {
  it("proxies fetch with the box token and secret name, and gates raw reads", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const target = await startFakeHttp();
    const gateway = await startFakeGateway({
      secrets: {
        brave: {
          value: "brave-secret",
          header: "X-Subscription-Token",
          hosts: ["127.0.0.1"],
        },
        bot: { value: "bot-secret" },
      },
      raw: ["bot"],
      upstreams: {},
    });
    let fetchStatus: number | undefined;
    let got: string | undefined;
    let refused: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "use_gateway",
            description: "Use secrets through the gateway",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const response = await ctx.secrets.fetch("brave", `${target.url}/x`);
              fetchStatus = response.status;
              got = await ctx.secrets.get("bot");
              refused = await ctx.secrets.get("forbidden").then(
                () => undefined,
                (failure: unknown) => failure,
              );
              return "used";
            },
          }),
        ],
      }),
      { secrets: ["brave", "bot", "forbidden"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("use_gateway"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
        secrets: {
          brave: {
            from: "env:BRAVE",
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
          bot: { from: "env:BOT" },
          forbidden: { from: "env:FORBIDDEN" },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(fetchStatus).toBe(200);
    expect(target.requests[0]!.headers["x-subscription-token"]).toBe("brave-secret");
    const proxy = gateway.requests.find(
      (request) => request.path === "/plugins/secrets-gateway/open/proxy",
    );
    expect(proxy?.headers.authorization).toBe("Bearer box-token");
    expect(proxy?.body).toMatchObject({ secret: "brave", url: `${target.url}/x` });
    const raw = gateway.requests.find(
      (request) => request.path === "/plugins/secrets-gateway/open/raw",
    );
    expect(raw?.headers.authorization).toBe("Bearer box-token");
    expect(raw?.body).toMatchObject({ secret: "bot" });
    expect(got).toBe("bot-secret");
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("forbidden");
    expect(process.env[BOX_TOKEN]).toBe("box-token");
    expect(JSON.stringify(process.env)).not.toContain("brave-secret");
  });
});

describe("gateway backend: startup validation", () => {
  it("fails naming an unset gateway token variable", async () => {
    delete process.env[BOX_TOKEN];
    await expect(
      startTestAgent(
        testDefinition({
          secretsBackend: { kind: "gateway", url: "http://127.0.0.1:1", tokenEnv: BOX_TOKEN },
        }),
      ),
    ).rejects.toThrow(new RegExp(BOX_TOKEN));
  });
});

describe("gateway backend: model calls", () => {
  it("uses the gateway upstream path and lets the gateway add the provider key", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const llm = await startFakeLlm();
    const gateway = await startFakeGateway({
      secrets: {},
      raw: [],
      upstreams: { main: { baseUrl: llm.url, apiKey: "provider-key" } },
    });
    const def: AgentDefinition = testDefinition({
      model: {
        provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_PROVIDER_KEY" },
        modelId: "m1",
      },
      secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
    });
    const agent = await startTestAgent(def, { models: undefined });
    const { id } = await agent.host.createConversation();
    const { message } = await agent.host.submitInput(id, "hello", { wait: true });

    expect(message?.content).toEqual([{ type: "text", text: "ok" }]);
    const forwarded = gateway.requests.find((request) =>
      request.path.startsWith("/plugins/secrets-gateway/open/llm/main/"),
    );
    expect(forwarded?.path).toBe("/plugins/secrets-gateway/open/llm/main/chat/completions");
    expect(forwarded?.headers.authorization).toBe("Bearer box-token");
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.headers.authorization).toBe("Bearer provider-key");
    expect(llm.requests[0]!.headers.authorization).not.toBe("Bearer box-token");
  });
});
