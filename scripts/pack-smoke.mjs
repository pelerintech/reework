#!/usr/bin/env node
// Pack-smoke: build and pack the four publishable packages, install the tarballs
// into a clean consumer project with npm, type-check an agent module against
// them, start it with `npx reework start`, and talk to it with @reework/client.
// Proves the tarballs work the way a real project consumes them (v04 does).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = ["types", "client", "core", "tui"];
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const work = mkdtempSync(join(tmpdir(), "reework-pack-smoke-"));
const tarballs = join(work, "tarballs");
const consumer = join(work, "consumer");
console.log(`pack-smoke: working in ${work}`);

run("pnpm", ["-r", "--filter", "./packages/*", "build"], ROOT);
for (const name of PACKAGES) {
  run("pnpm", ["pack", "--pack-destination", tarballs], join(ROOT, "packages", name));
}
const tarball = (name) => {
  const file = readdirSync(tarballs).find((f) => f.startsWith(`reework-${name}-`));
  if (!file) throw new Error(`no tarball for ${name}`);
  return `file:${join(tarballs, file)}`;
};
const local = Object.fromEntries(PACKAGES.map((name) => [`@reework/${name}`, tarball(name)]));

execFileSync("mkdir", ["-p", consumer]);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "pack-smoke-consumer",
      private: true,
      type: "module",
      dependencies: local,
      devDependencies: { typescript: "5.9.3", "@types/node": "^24.0.0" },
      // Cross-package dependencies resolve to the tarballs, never the registry.
      overrides: local,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["*.ts"],
  }),
);
writeFileSync(
  join(consumer, "agent.ts"),
  `import { defineAgent, definePlugin, gatedAction } from "@reework/core";
import type { Proposal } from "@reework/types";

const describe = (proposal: Proposal): string => proposal.title;

const ops = definePlugin("ops", (config: { service: string }) => ({
  tools: [
    gatedAction({
      name: "restart",
      gate: { title: \`Restart \${config.service}?\`, options: [{ id: "go", label: "Go" }] },
      run: async () => describe({ id: "x", conversationId: "1", title: "done", options: [], acceptFreeForm: false, createdAt: 0 }),
    }),
  ],
}));

export default defineAgent({
  name: "pack-smoke",
  model: { provider: { baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "SMOKE_LLM_KEY" }, modelId: "m1" },
  plugins: [{ plugin: ops, config: { service: "worker" } }],
  channels: [],
  mission: { role: "You are a pack-smoke agent.", tools: ["restart"] },
});
`,
);
writeFileSync(
  join(consumer, "talk.mjs"),
  `import { createClient } from "@reework/client";
const client = createClient({ baseUrl: process.argv[2], token: process.env.REEWORK_API_TOKEN });
const { ok } = await client.health();
const conversation = await client.createConversation({ key: "smoke" });
const proposals = await client.listProposals();
if (!ok || !conversation.created || proposals.length !== 0) throw new Error("unexpected protocol answers");
console.log("talk: ok");
`,
);

run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], consumer);
run("npx", ["tsc", "-p", "."], consumer);

const env = { ...process.env, SMOKE_LLM_KEY: "k", REEWORK_API_TOKEN: "smoke-token" };
const agent = spawn(
  "npx",
  ["reework", "start", "agent.ts", "--port", "0", "--storage", "smoke.sqlite"],
  {
    cwd: consumer,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const port = await new Promise((resolvePort, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`agent did not start: ${output}`)), 30_000);
  agent.stdout.on("data", (chunk) => {
    output += chunk;
    const match = /listening on (\d+)/.exec(output);
    if (match) {
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    }
  });
  agent.once("exit", (code) => reject(new Error(`agent exited ${code}: ${output}`)));
});
const base = `http://127.0.0.1:${port}`;
const health = await fetch(`${base}/health`);
if (health.status !== 200) throw new Error(`health returned ${health.status}`);
execFileSync("node", ["talk.mjs", base], { cwd: consumer, env, stdio: "inherit" });

const code = await new Promise((resolveExit) => {
  agent.once("exit", resolveExit);
  agent.kill("SIGTERM");
});
if (code !== 0) throw new Error(`agent exited ${code} on SIGTERM`);
console.log("pack-smoke: ✓ tarballs install, type-check, start, and serve the protocol");
