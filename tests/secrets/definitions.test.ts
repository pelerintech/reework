// Secret definitions are validated at startup: a missing local source fails
// before the agent opens, naming the secret; a file source reaches a target.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type, definePlugin, defineTool } from "@reework/core";
import type { AgentDefinition } from "@reework/core";
import { text, toolCall } from "@reework/core/testing";
import { fauxModels, startTestAgent, testDefinition } from "../support/agent.ts";
import { startFakeHttp } from "../support/fake-http.ts";

const MISSING_ENV = "REEWORK_TEST_MISSING_SECRET";
const LLM_ENV = "REEWORK_TEST_LLM_SECRET";
const dirs: string[] = [];

afterEach(() => {
  delete process.env[MISSING_ENV];
  delete process.env[LLM_ENV];
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function definition(secrets: AgentDefinition["secrets"]): AgentDefinition {
  return testDefinition({ secrets });
}

function keyFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reework-secret-"));
  dirs.push(dir);
  const path = join(dir, "key");
  writeFileSync(path, contents);
  return path;
}

describe("secret definitions: startup validation", () => {
  it("fails naming a secret whose environment variable is missing", async () => {
    delete process.env[MISSING_ENV];
    await expect(
      startTestAgent(
        definition({
          brave: {
            from: `env:${MISSING_ENV}`,
            apply: { header: "X-Subscription-Token" },
            hosts: ["127.0.0.1"],
          },
        }),
      ),
    ).rejects.toThrow(/secret "brave"/);
  });
});

describe("secret definitions: malformed definitions", () => {
  it("fails naming an unknown from form", async () => {
    await expect(
      startTestAgent(
        definition({
          odd: { from: "vault:key", apply: { header: "X-Key" }, hosts: ["127.0.0.1"] },
        }),
      ),
    ).rejects.toThrow(/secret "odd".*unknown from/);
  });

  it("fails naming a definition that sets both header and query", async () => {
    await expect(
      startTestAgent(
        definition({
          both: {
            from: `env:${MISSING_ENV}`,
            apply: { header: "X-Key", query: "key" } as never,
            hosts: ["127.0.0.1"],
          },
        }),
      ),
    ).rejects.toThrow(/secret "both".*exactly one of header or query/);
  });

  it("fails naming a fetchable secret without hosts", async () => {
    await expect(
      startTestAgent(
        definition({
          fetchable: { from: `env:${MISSING_ENV}`, apply: { header: "X-Key" } },
        }),
      ),
    ).rejects.toThrow(/secret "fetchable".*hosts/);
  });

  it("accepts a model-key secret without hosts", async () => {
    process.env[LLM_ENV] = "llm-key";
    const agent = await startTestAgent(
      testDefinition({
        model: {
          provider: {
            baseUrl: "http://127.0.0.1:1",
            apiKey: { secret: "llm" },
          },
          modelId: "m1",
        },
        secrets: { llm: { from: `env:${LLM_ENV}` } },
      }),
    );
    expect(agent.agent.name).toBe("test-agent");
  });
});

describe("secret definitions: file-backed secrets", () => {
  it("resolves a file secret and sends it as the configured header", async () => {
    const target = await startFakeHttp();
    let status: number | undefined;
    const caller = definePlugin(
      "caller",
      () => ({
        tools: [
          defineTool({
            name: "call_target",
            description: "Call the target with a file-backed secret",
            parameters: Type.Object({}),
            async execute(_args, ctx) {
              const response = await ctx.secrets.fetch("filekey", `${target.url}/x`);
              status = response.status;
              return "called";
            },
          }),
        ],
      }),
      { secrets: ["filekey"] },
    );
    const faux = fauxModels("m1");
    faux.respond([toolCall("call_target"), text("done")]);
    const agent = await startTestAgent(
      testDefinition({
        secrets: {
          filekey: {
            from: `file:${keyFile("file-key")}`,
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

    expect(status).toBe(200);
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]!.headers["x-key"]).toBe("file-key");
  });
});
