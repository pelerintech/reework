// ctx.secrets.fetch sends a request with a declared secret applied, only to the
// hosts its definition allows, and reaches every plugin context.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool, gatedAction } from "@reework/core";
import type {
  PluginEventContext,
  PluginHookContext,
  PluginRouteContext,
  PluginSetupContext,
  ToolContext,
} from "@reework/core";
import { waitFor, waitForProposal } from "@reework/core/testing";
import { authedApp, fauxModels, startTestAgent, testDefinition } from "../support/agent.ts";
import { startFakeHttp } from "../support/fake-http.ts";
import { text, toolCall } from "@reework/core/testing";

const BRAVE_ENV = "REEWORK_TEST_BRAVE";
const QUERY_ENV = "REEWORK_TEST_QUERY";

afterEach(() => {
  delete process.env[BRAVE_ENV];
  delete process.env[QUERY_ENV];
});

describe("ctx.secrets.fetch: applying a secret", () => {
  it("applies a header secret and returns a response without the value", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const target = await startFakeHttp();
    const seen: { status?: number; body?: string } = {};
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "call_brave",
            description: "Call the target with the brave secret",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const response = await ctx.secrets.fetch("brave", `${target.url}/x`);
              seen.status = response.status;
              seen.body = await response.text();
              return "called";
            },
          }),
        ],
      }),
      { secrets: ["brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("call_brave"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          brave: {
            from: `env:${BRAVE_ENV}`,
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(seen.status).toBe(200);
    expect(seen.body).not.toContain("brave-secret");
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]!.headers["x-subscription-token"]).toBe("brave-secret");
  });

  it("applies a query secret beside existing query parameters", async () => {
    process.env[QUERY_ENV] = "query-secret";
    const target = await startFakeHttp();
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "call_query",
            description: "Call the target with a query secret",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              await ctx.secrets.fetch("query", `${target.url}/x?existing=1`);
              return "called";
            },
          }),
        ],
      }),
      { secrets: ["query"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("call_query"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          query: {
            from: `env:${QUERY_ENV}`,
            apply: { query: "key" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(target.requests).toHaveLength(1);
    const url = new URL(`http://127.0.0.1${target.requests[0]!.path}`);
    expect(url.searchParams.get("existing")).toBe("1");
    expect(url.searchParams.get("key")).toBe("query-secret");
  });

  it("refuses a host outside the secret's hosts, naming host and secret", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const target = await startFakeHttp();
    const localhost = target.url.replace("127.0.0.1", "localhost");
    let error: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "call_elsewhere",
            description: "Call a host the secret does not allow",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              error = await ctx.secrets.fetch("brave", `${localhost}/x`).then(
                () => undefined,
                (failure: unknown) => failure,
              );
              return "called";
            },
          }),
        ],
      }),
      { secrets: ["brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("call_elsewhere"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          brave: {
            from: `env:${BRAVE_ENV}`,
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: caller, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(target.requests).toHaveLength(0);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("brave");
    expect(message).toContain("localhost");
  });
});

describe("undeclared secrets", () => {
  it("refuses fetch and get for a name the plugin did not declare", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const target = await startFakeHttp();
    let fetchError: unknown;
    let getError: unknown;
    const sneaky = definePlugin("sneaky", () => ({
      tools: [
        defineTool({
          name: "sneak",
          description: "Use a secret the plugin did not declare",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            fetchError = await ctx.secrets.fetch("brave", `${target.url}/x`).then(
              () => undefined,
              (failure: unknown) => failure,
            );
            getError = await ctx.secrets.get("brave").then(
              () => undefined,
              (failure: unknown) => failure,
            );
            return "tried";
          },
        }),
      ],
    }));
    const faux = fauxModels("m1");
    faux.respond([toolCall("sneak"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          brave: {
            from: `env:${BRAVE_ENV}`,
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: sneaky, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(target.requests).toHaveLength(0);
    expect(fetchError).toBeInstanceOf(Error);
    expect((fetchError as Error).message).toContain("brave");
    expect(getError).toBeInstanceOf(Error);
    expect((getError as Error).message).toContain("brave");
  });
});

describe("ctx.secrets in every plugin context", () => {
  it("offers fetch and get to tools, hooks, events, setup, routes and gated actions", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const seen: {
      setup?: PluginSetupContext<unknown>["secrets"];
      route?: PluginRouteContext<unknown>["secrets"];
      hook?: PluginHookContext["secrets"];
      event?: PluginEventContext["secrets"];
      gate?: unknown;
      run?: unknown;
      tool?: ToolContext["secrets"];
    } = {};
    const everywhere = definePlugin("everywhere", () => ({
      tools: [
        defineTool({
          name: "read_secrets",
          description: "Read the secrets surface",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            seen.tool = ctx.secrets;
            return "ok";
          },
        }),
        gatedAction({
          name: "act",
          gate(_args, ctx) {
            seen.gate = ctx.secrets;
            return { title: "Act?", options: [{ id: "yes", label: "Yes" }] };
          },
          async run(ctx) {
            seen.run = ctx.secrets;
            return "acted";
          },
        }),
      ],
      setup(ctx) {
        seen.setup = ctx.secrets;
      },
      routes(app, ctx) {
        app.get("/check", (c) => {
          seen.route = ctx.secrets;
          return c.json({ ok: true });
        });
      },
      hooks: {
        async beforeModelRequest(_input, ctx) {
          seen.hook = ctx.secrets;
        },
        async onInput(_input, ctx) {
          seen.event = ctx.secrets;
        },
      },
    }));
    const faux = fauxModels("m1");
    faux.respond([toolCall("read_secrets"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          brave: {
            from: `env:${BRAVE_ENV}`,
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
        },
        plugins: [{ plugin: everywhere, config: {} }],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    const response = await authedApp(agent).request("/plugins/everywhere/check");
    expect(response.status).toBe(200);

    faux.respond([toolCall("act"), text("waiting for approval")]);
    await agent.host.submitInput(id, "act");
    const proposal = await waitForProposal(agent.host, id);
    faux.append([text("done")]);
    await agent.host.submitDecision({
      proposalId: proposal.id,
      selectedOption: "yes",
      instruction: null,
    });
    await waitFor(() => seen.run !== undefined);

    for (const [surface, secrets] of Object.entries(seen)) {
      expect(secrets, `${surface} secrets`).toBeDefined();
      expect(typeof (secrets as { fetch?: unknown }).fetch, `${surface} fetch`).toBe("function");
      expect(typeof (secrets as { get?: unknown }).get, `${surface} get`).toBe("function");
    }
    expect(seen.setup).toBeDefined();
    expect(seen.route).toBeDefined();
    expect(seen.hook).toBeDefined();
    expect(seen.event).toBeDefined();
    expect(seen.gate).toBeDefined();
    expect(seen.run).toBeDefined();
    expect(seen.tool).toBeDefined();
  });
});
