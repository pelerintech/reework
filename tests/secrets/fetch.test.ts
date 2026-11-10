// ctx.secrets.fetch sends a request with a declared secret applied, only to the
// hosts its definition allows, and reaches every plugin context.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool, gatedAction } from "@reework/core";
import type {
  PluginEventContext,
  SecretUseEvent,
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

/** Fetch `url` with a brave secret restricted to `hosts`; returns status or error. */
async function fetchWithHosts(
  hosts: string[],
  url: string,
): Promise<{ status?: number; error?: unknown }> {
  process.env[BRAVE_ENV] = "brave-secret";
  let status: number | undefined;
  let error: unknown;
  const caller = definePlugin(
    "caller",
    () => ({
      tools: [
        defineTool({
          name: "call_host",
          description: "Call a target with a restricted secret",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            await ctx.secrets.fetch("brave", url).then(
              (response) => {
                status = response.status;
              },
              (failure: unknown) => {
                error = failure;
              },
            );
            return "done";
          },
        }),
      ],
    }),
    { secrets: ["brave"] },
  );
  const faux = fauxModels("m1");
  faux.respond([toolCall("call_host"), text("done")]);
  const agent = await startTestAgent(
    testDefinition({
      secrets: {
        brave: { from: `env:${BRAVE_ENV}`, apply: { header: "X-Key" }, hosts },
      },
      plugins: [{ plugin: caller, config: {} }],
    }),
    { models: faux.models },
  );
  const { id } = await agent.host.createConversation();
  await agent.host.submitInput(id, "go", { wait: true });
  return { status, error };
}

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
    let responseUrl: string | undefined;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "call_query",
            description: "Call the target with a query secret",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const response = await ctx.secrets.fetch("query", `${target.url}/x?existing=1`);
              responseUrl = response.url;
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
    expect(responseUrl).toBeDefined();
    expect(responseUrl).not.toContain("query-secret");
    const returned = new URL(responseUrl!);
    expect(returned.searchParams.get("existing")).toBe("1");
    expect(returned.searchParams.get("key")).toBe("[redacted]");
  });

  it("refuses a host outside the secret's hosts, naming host and secret", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const target = await startFakeHttp();
    const localhost = target.url.replace("127.0.0.1", "localhost");
    const uses: SecretUseEvent[] = [];
    const observer = definePlugin("audit", () => ({
      hooks: {
        async onSecretUse(input) {
          uses.push(input);
        },
      },
    }));
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
        plugins: [
          { plugin: observer, config: {} },
          { plugin: caller, config: {} },
        ],
      }),
      { models: faux.models },
    );
    const { id } = await agent.host.createConversation();
    await agent.host.submitInput(id, "go", { wait: true });

    expect(target.requests).toHaveLength(0);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("brave");
    expect(message).toContain("localhost");
    await waitFor(() => uses.length >= 1);
    expect(uses.find((use) => use.kind === "fetch")).toMatchObject({
      plugin: "caller",
      name: "brave",
      kind: "fetch",
      outcome: "refused",
    });
  });
});

describe("ctx.secrets.fetch: redirects", () => {
  it("refuses a redirect to a host outside the secret's hosts, sending nothing there", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const allowed = await startFakeHttp();
    const disallowed = await startFakeHttp();
    const localhost = disallowed.url.replace("127.0.0.1", "localhost");
    allowed.respond({ status: 302, headers: { location: `${localhost}/leak` } });
    let error: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "redirect_out",
            description: "Follow a redirect to a disallowed host",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              error = await ctx.secrets.fetch("brave", `${allowed.url}/start`).then(
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
    faux.respond([toolCall("redirect_out"), text("done")]);
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

    expect(allowed.requests[0]!.headers["x-subscription-token"]).toBe("brave-secret");
    expect(disallowed.requests).toHaveLength(0);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("brave");
    expect(message).toContain("localhost");
  });

  it("refuses a query-secret redirect to a disallowed host", async () => {
    process.env[QUERY_ENV] = "query-secret";
    const allowed = await startFakeHttp();
    const disallowed = await startFakeHttp();
    const localhost = disallowed.url.replace("127.0.0.1", "localhost");
    allowed.respond({ status: 302, headers: { location: `${localhost}/leak` } });
    let error: unknown;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "redirect_query_out",
            description: "Follow a query-secret redirect to a disallowed host",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              error = await ctx.secrets.fetch("query", `${allowed.url}/start`).then(
                () => undefined,
                (failure: unknown) => failure,
              );
              return "tried";
            },
          }),
        ],
      }),
      { secrets: ["query"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("redirect_query_out"), text("done")]);
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

    expect(new URL(`http://127.0.0.1${allowed.requests[0]!.path}`).searchParams.get("key")).toBe(
      "query-secret",
    );
    expect(disallowed.requests).toHaveLength(0);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("query");
    expect(message).toContain("localhost");
  });

  it("follows a redirect to another allowed host and applies the secret there", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const first = await startFakeHttp();
    const second = await startFakeHttp();
    first.respond({ status: 302, headers: { location: `${second.url}/next` } });
    second.respond({ status: 200, body: JSON.stringify({ ok: true }) });
    let status: number | undefined;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "redirect_allowed",
            description: "Follow a redirect to another allowed host",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const response = await ctx.secrets.fetch("brave", `${first.url}/start`);
              status = response.status;
              return "called";
            },
          }),
        ],
      }),
      { secrets: ["brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("redirect_allowed"), text("done")]);
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

    expect(status).toBe(200);
    expect(second.requests[0]!.headers["x-subscription-token"]).toBe("brave-secret");
  });
});

describe("ctx.secrets.fetch: host entries", () => {
  it("restricts a host:port entry to that port", async () => {
    const target = await startFakeHttp();
    const port = new URL(target.url).port;
    const allowed = await fetchWithHosts([`127.0.0.1:${port}`], `${target.url}/x`);
    expect(allowed.status).toBe(200);
    expect(target.requests).toHaveLength(1);

    const wrongPort = await fetchWithHosts([`127.0.0.1:${Number(port) + 1}`], `${target.url}/x`);
    expect(wrongPort.error).toBeInstanceOf(Error);
    const message = wrongPort.error instanceof Error ? wrongPort.error.message : "";
    expect(message).toContain("brave");
    expect(message).toContain("127.0.0.1");
    expect(target.requests).toHaveLength(1);
  });

  it("treats ::1 and [::1] as equivalent hosts", async () => {
    const target = await startFakeHttp("::1");
    const bare = await fetchWithHosts(["::1"], `${target.url}/x`);
    expect(bare.status).toBe(200);
    expect(target.requests).toHaveLength(1);

    const bracketed = await fetchWithHosts(["[::1]"], `${target.url}/x`);
    expect(bracketed.status).toBe(200);
    expect(target.requests).toHaveLength(2);
  });

  it("allows any port for a plain host", async () => {
    const first = await startFakeHttp();
    const second = await startFakeHttp();
    const a = await fetchWithHosts(["127.0.0.1"], `${first.url}/x`);
    const b = await fetchWithHosts(["127.0.0.1"], `${second.url}/x`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });
});

describe("undeclared secrets", () => {
  it("refuses fetch and get for a name the plugin did not declare", async () => {
    process.env[BRAVE_ENV] = "brave-secret";
    const target = await startFakeHttp();
    const uses: SecretUseEvent[] = [];
    const observer = definePlugin("audit", () => ({
      hooks: {
        async onSecretUse(input) {
          uses.push(input);
        },
      },
    }));
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
        plugins: [
          { plugin: observer, config: {} },
          { plugin: sneaky, config: {} },
        ],
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
    await waitFor(() => uses.length >= 2);
    expect(uses.find((use) => use.kind === "fetch")).toMatchObject({
      plugin: "sneaky",
      name: "brave",
      kind: "fetch",
      outcome: "refused",
    });
    expect(uses.find((use) => use.kind === "get")).toMatchObject({
      plugin: "sneaky",
      name: "brave",
      kind: "get",
      outcome: "refused",
    });
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
