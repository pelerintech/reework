// ctx.secrets.get returns a declared secret raw and, like fetch, is visible to
// plugins through the onSecretUse audit event.
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { SecretUseEvent } from "@reework/core";
import { text, toolCall, waitFor } from "@reework/core/testing";
import { fauxModels, startTestAgent, testDefinition } from "../support/agent.ts";
import { startFakeHttp } from "../support/fake-http.ts";

const BOT_ENV = "REEWORK_TEST_BOT";
const BRAVE_ENV = "REEWORK_TEST_BRAVE";

afterEach(() => {
  delete process.env[BOT_ENV];
  delete process.env[BRAVE_ENV];
});

describe("ctx.secrets.get", () => {
  it("returns the value and fires onSecretUse for get and fetch", async () => {
    process.env[BOT_ENV] = "bot-secret";
    process.env[BRAVE_ENV] = "brave-secret";
    const target = await startFakeHttp();
    const uses: SecretUseEvent[] = [];
    let got: string | undefined;
    const observer = definePlugin("audit", () => ({
      hooks: {
        async onSecretUse(input) {
          uses.push(input);
        },
      },
    }));
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "use_secrets",
            description: "Read a raw secret and fetch with another",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              got = await ctx.secrets.get("bot");
              await ctx.secrets.fetch("brave", `${target.url}/x`);
              return "used";
            },
          }),
        ],
      }),
      { secrets: ["bot", "brave"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("use_secrets"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          bot: { from: `env:${BOT_ENV}` },
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

    expect(got).toBe("bot-secret");
    expect(target.requests[0]!.headers["x-subscription-token"]).toBe("brave-secret");
    await waitFor(() => uses.length >= 2);
    const get = uses.find((use) => use.kind === "get");
    expect(get).toMatchObject({ plugin: "caller", name: "bot", kind: "get", outcome: "used" });
    expect(typeof get?.at).toBe("number");
    const fetch = uses.find((use) => use.kind === "fetch");
    expect(fetch).toMatchObject({
      plugin: "caller",
      name: "brave",
      kind: "fetch",
      outcome: "used",
    });
    expect(fetch?.conversationId).toBe(id);
  });
});
