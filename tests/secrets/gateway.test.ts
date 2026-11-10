// The gateway backend keeps secret values out of the agent: fetch proxies through
// the gateway, raw reads obey the token, and model calls use the gateway's
// upstream path.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition, SecretUseEvent } from "@reework/core";
import { text, toolCall, waitFor } from "@reework/core/testing";
import { fauxModels, startTestAgent, TEST_TOKEN, testDefinition } from "../support/agent.ts";
import { startFakeGateway } from "../support/fake-gateway.ts";
import { startFakeHttp, startHangingHttp } from "../support/fake-http.ts";
import { startFakeLlm } from "../support/fake-llm.ts";
import { createClient } from "@reework/client";

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
    const uses: SecretUseEvent[] = [];
    const observer = definePlugin("audit", () => ({
      hooks: {
        async onSecretUse(input) {
          uses.push(input);
        },
      },
    }));
    let fetchStatus: number | undefined;
    let deniedStatus: number | undefined;
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
              const denied = await ctx.secrets.fetch("denied", `${target.url}/x`);
              deniedStatus = denied.status;
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
      { secrets: ["brave", "denied", "bot", "forbidden"] },
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
          denied: {
            from: "env:DENIED",
            apply: { header: "X-Denied" },
            hosts: ["127.0.0.1"],
          },
          bot: { from: "env:BOT" },
          forbidden: { from: "env:FORBIDDEN" },
        },
        plugins: [
          { plugin: observer, config: {} },
          { plugin: caller, config: {} },
        ],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(fetchStatus).toBe(200);
    expect(deniedStatus).toBe(403);
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
    await waitFor(() => uses.length >= 4);
    expect(uses.find((use) => use.kind === "fetch" && use.name === "brave")).toMatchObject({
      plugin: "caller",
      name: "brave",
      kind: "fetch",
      outcome: "used",
    });
    expect(uses.find((use) => use.kind === "fetch" && use.name === "denied")).toMatchObject({
      plugin: "caller",
      name: "denied",
      kind: "fetch",
      outcome: "refused",
    });
    expect(uses.find((use) => use.kind === "get" && use.name === "bot")).toMatchObject({
      plugin: "caller",
      name: "bot",
      kind: "get",
      outcome: "used",
    });
    expect(uses.find((use) => use.kind === "get" && use.name === "forbidden")).toMatchObject({
      plugin: "caller",
      name: "forbidden",
      kind: "get",
      outcome: "refused",
    });
    expect(process.env[BOX_TOKEN]).toBe("box-token");
    expect(JSON.stringify(process.env)).not.toContain("brave-secret");
  });
});

describe("gateway backend: request bodies, aborts and timeouts", () => {
  it("passes a binary body to the gateway as base64", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const target = await startFakeHttp();
    const gateway = await startFakeGateway({
      secrets: { brave: { value: "brave-secret", header: "X-Key", hosts: ["127.0.0.1"] } },
      raw: [],
      upstreams: {},
    });
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "post_binary",
            description: "Post binary bytes through the gateway",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.secrets.fetch("brave", `${target.url}/x`, {
                method: "POST",
                body: new Uint8Array([0x68, 0x69]),
              });
              return "posted";
            },
          }),
        ],
      }),
      { secrets: ["brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("post_binary"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
        secrets: {
          brave: {
            from: "env:BRAVE",
            apply: { header: "X-Key" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(target.requests[0]!.body).toBe("hi");
    const proxy = gateway.requests.find(
      (request) => request.path === "/plugins/secrets-gateway/open/proxy",
    );
    expect(proxy?.body.bodyBase64).toBe("aGk=");
    expect(proxy?.body.body).toBeUndefined();
  });

  it("honours the caller's abort signal", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const target = await startFakeHttp();
    const gateway = await startFakeGateway({
      secrets: { brave: { value: "brave-secret", header: "X-Key", hosts: ["127.0.0.1"] } },
      raw: [],
      upstreams: {},
    });
    let error: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "abort_fetch",
            description: "Abort a gateway fetch",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const controller = new AbortController();
              controller.abort();
              error = await ctx.secrets
                .fetch("brave", `${target.url}/x`, { signal: controller.signal })
                .then(
                  () => undefined,
                  (failure: unknown) => failure,
                );
              return "tried";
            },
          }),
        ],
      }),
      { secrets: ["brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("abort_fetch"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
        secrets: {
          brave: {
            from: "env:BRAVE",
            apply: { header: "X-Key" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(gateway.requests).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("brave");
  });

  it("times out a hanging gateway, naming the secret", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const hanging = await startHangingHttp();
    let error: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "hang_fetch",
            description: "Fetch through a hanging gateway",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              error = await ctx.secrets.fetch("brave", "http://127.0.0.1:1/x").then(
                () => undefined,
                (failure: unknown) => failure,
              );
              return "tried";
            },
          }),
        ],
      }),
      { secrets: ["brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("hang_fetch"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secretsBackend: {
          kind: "gateway",
          url: hanging.url,
          tokenEnv: BOX_TOKEN,
          timeoutMs: 50,
        },
        secrets: {
          brave: {
            from: "env:BRAVE",
            apply: { header: "X-Key" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("brave");
  });

  it("names the secret when a raw reply is not JSON", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const gateway = await startFakeHttp();
    gateway.respond({ status: 200, body: "oops" });
    let error: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "bad_raw",
            description: "Read a raw value from a non-JSON gateway",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              error = await ctx.secrets.get("bot").then(
                () => undefined,
                (failure: unknown) => failure,
              );
              return "tried";
            },
          }),
        ],
      }),
      { secrets: ["bot"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("bad_raw"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
        secrets: { bot: { from: "env:BOT" } },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("bot");
  });
});

describe("gateway backend: model failure", () => {
  it("surfaces a gateway model failure as an error", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const gateway = await startFakeHttp();
    gateway.respond({ status: 500, body: JSON.stringify({ error: "gateway down" }) });
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_PROVIDER_KEY" },
          modelId: "m1",
        },
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
      }),
      { models: undefined, settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } } },
    );
    const { id } = await agent.host.createConversation();
    await expect(agent.host.submitInput(id, "hello", { wait: true })).rejects.toThrow();
  });
});

describe("gateway backend: model failure over HTTP", () => {
  it("returns a 5xx JSON body and the client surfaces the model error", async () => {
    process.env[BOX_TOKEN] = "box-token";
    const gateway = await startFakeHttp();
    gateway.respond({ status: 500, body: JSON.stringify({ error: "gateway down" }) });
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_PROVIDER_KEY" },
          modelId: "m1",
        },
        secretsBackend: { kind: "gateway", url: gateway.url, tokenEnv: BOX_TOKEN },
      }),
      { models: undefined, settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } } },
    );
    const { port, close } = await agent.listen(0);
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN });
    const { id } = await client.createConversation();
    const failure = await client.submit(id, "hello", { wait: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await close();

    expect(failure).toBeInstanceOf(Error);
    const status = (failure as { status?: number }).status;
    expect(status).toBeGreaterThanOrEqual(500);
    expect(status).toBeLessThan(600);
    expect((failure as Error).message).toContain("model error");
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
