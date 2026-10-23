import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./support/agent.ts";
import { startFakeLlm } from "./support/fake-llm.ts";

const CLI = resolve("packages/core/src/cli.ts");

describe("reework start", () => {
  it("starts the agent module it is given, serves it, and stops cleanly on SIGTERM", async () => {
    const llm = await startFakeLlm();
    const dir = mkdtempSync(join(tmpdir(), "reework-cli-"));
    mkdirSync(dir, { recursive: true });
    const agentFile = join(dir, "agent.ts");
    writeFileSync(
      agentFile,
      `export default {
        name: "cli-agent",
        model: { provider: { baseUrl: ${JSON.stringify(llm.url)}, apiKeyEnv: "CLI_LLM_KEY" }, modelId: "m1" },
        plugins: [],
        channels: [],
        mission: { role: "You are started from the CLI." },
      };\n`,
    );
    const storage = join(dir, "agent.sqlite");

    const child = spawn(
      process.execPath,
      ["--conditions=reework-source", CLI, "start", agentFile, "--port", "0", "--storage", storage],
      {
        env: { ...process.env, CLI_LLM_KEY: "k", REEWORK_API_TOKEN: TEST_TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error(`no port in output: ${output}`)), 15_000);
      child.stdout.on("data", () => {
        const match = /listening on (\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      child.once("exit", (code) => reject(new Error(`exited ${code}: ${output}`)));
    });

    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(existsSync(`${storage}.lock`)).toBe(true);

    const code = await new Promise<number | null>((resolveExit) => {
      child.once("exit", resolveExit);
      child.kill("SIGTERM");
    });
    expect(code).toBe(0);
    expect(existsSync(`${storage}.lock`)).toBe(false);
  }, 30_000);
});

describe("reework start under a stubborn tool", () => {
  it("exits at once with 130 on a second signal while stopping", async () => {
    const llm = await startFakeLlm();
    llm.script({ toolCall: { name: "stubborn" } });
    // Inside the repo, so the agent module can import @reework/core.
    const dir = mkdtempSync(join(resolve("tests"), ".tmp-cli-"));
    try {
      const marker = join(dir, "started");
      const agentFile = join(dir, "agent.ts");
      writeFileSync(
        agentFile,
        `import { Type, defineTool, definePlugin } from "@reework/core";
import { writeFileSync } from "node:fs";
const tools = definePlugin("stubborn", () => ({
  tools: [defineTool({ name: "stubborn", description: "Ignores cancellation", parameters: Type.Object({}),
    execute: async () => { writeFileSync(${JSON.stringify(marker)}, "1"); await new Promise(() => {}); return { output: [] }; } })],
}));
export default {
  name: "cli-agent",
  model: { provider: { baseUrl: ${JSON.stringify(llm.url)}, apiKeyEnv: "CLI_LLM_KEY" }, modelId: "m1" },
  plugins: [{ plugin: tools, config: {} }], channels: [], mission: { role: "r" },
};\n`,
      );
      const child = spawn(
        process.execPath,
        [
          "--conditions=reework-source",
          CLI,
          "start",
          agentFile,
          "--port",
          "0",
          "--storage",
          join(dir, "a.sqlite"),
        ],
        {
          env: { ...process.env, CLI_LLM_KEY: "k", REEWORK_API_TOKEN: TEST_TOKEN },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const port = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(() => reject(new Error(`no port: ${output}`)), 15_000);
        child.stdout.on("data", () => {
          const match = /listening on (\d+)/.exec(output);
          if (match) {
            clearTimeout(timer);
            resolvePort(Number(match[1]));
          }
        });
      });
      const headers = { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };
      const base = `http://127.0.0.1:${port}`;
      const { id } = (await (
        await fetch(`${base}/conversations`, { method: "POST", headers, body: "{}" })
      ).json()) as { id: string };
      await fetch(`${base}/conversations/${id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "go" }),
      });
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(marker)).toBe(true);

      const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      const begun = Date.now();
      child.kill("SIGINT");
      expect(await exited).toBe(130);
      expect(Date.now() - begun).toBeLessThan(1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
