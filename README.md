# reework

A thin framework for durable, human-in-the-loop agents on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). An agent runs as a server, works through
its tools, and asks a human before consequential actions. Gates suspend only that action, survive restarts, and
resume the agent with the human's decision.

| Package           | What it is                                                                        |
| ----------------- | --------------------------------------------------------------------------------- |
| `@reework/core`   | `defineAgent`, `definePlugin`, `gatedAction`, `startAgent`, and the `reework` CLI |
| `@reework/types`  | Shared protocol types and the `ROUTES` table                                      |
| `@reework/client` | Protocol client for the TUI, agent projects, and external systems                 |
| `@reework/tui`    | Terminal client (`reework-tui`): inbox of open gates and conversations            |

Requires Node ≥ 22.18.

## Define and start an agent

### 1. Write a plugin

A plugin is a named factory from its config to the tools (and prompt sections, tasks, setup, workspace) it adds.
Validate config in the factory: a throw stops startup and names the plugin.

```ts
// plugins/ops.ts
import { definePlugin, defineTool, gatedAction } from "@reework/core";
import { Type } from "@earendil-works/pi-ai";

export const ops = definePlugin("ops", (config: { service: string }) => ({
  tools: [
    defineTool({
      name: "status",
      description: `Status of ${config.service}.`,
      parameters: Type.Object({}),
      async execute() {
        return { output: [{ type: "text", text: `${config.service}: degraded` }] };
      },
    }),
    // Opens a gate, suspends only this action, and resumes the agent with the outcome.
    gatedAction({
      name: "restart",
      parameters: Type.Object({ reason: Type.String() }),
      gate: (args) => ({
        title: `Restart ${config.service}?`,
        attachments: [{ kind: "markdown", title: "Why", content: args.reason }],
        options: [
          { id: "restart", label: "Restart" },
          { id: "wait", label: "Keep watching" },
        ],
        acceptFreeForm: true,
      }),
      async run(_ctx, decision) {
        return decision.selectedOption === "restart" ? "restarted" : "left running";
      },
    }),
  ],
}));
```

Plugin tools marked `replay: "safe"` rerun after a crash. Wrap their effects in `once(api, key, ctx, fn)` or
`onceInCommit(api, ctx, fn)` so a rerun doesn't repeat them.

### 2. Define the agent

```ts
// agent.ts
import { defineAgent } from "@reework/core";
import { ops } from "./plugins/ops.ts";

export default defineAgent({
  name: "oncall",
  model: {
    // OpenAI-compatible by default; set `api: "anthropic-messages"` (and drop `/v1`) for Anthropic-style endpoints.
    provider: { baseUrl: "https://llm.internal/v1", apiKeyEnv: "ONCALL_LLM_KEY" },
    modelId: "qwen3-coder",
  },
  plugins: [{ plugin: ops, config: { service: "worker" } }],
  channels: [],
  mission: {
    role: "You are the on-call engineer. Investigate, then ask before acting.",
    tools: ["status", "restart"], // optional allowlist; omit to offer every installed tool
  },
  // Optional custom routes, mounted outside the API token: authenticate them yourself.
  routes: (app, host) => {
    app.post("/alerts", async (c) => {
      const alert = await c.req.json<{ id: string; title: string }>();
      const conversation = await host.createConversation({ key: `alert-${alert.id}` });
      await host.submitInput(conversation.id, `Alert: ${alert.title}`, { requestId: alert.id });
      return c.json({ conversationId: conversation.id }, 202);
    });
  },
});
```

### 3. Start it

```sh
export ONCALL_LLM_KEY=sk-...
export REEWORK_API_TOKEN=$(openssl rand -hex 32)   # guards every built-in route except /health
npx reework start agent.ts --port 8080 --storage ./data/oncall.sqlite
```

Or start it from your own code with `const agent = await startAgent(definition, { storagePath }); await agent.listen(8080);`.
State lives in the SQLite file. Restart the process and unfinished runs and open gates carry on.

### 4. Attach the TUI

```sh
REEWORK_TUI_URL=http://127.0.0.1:8080 REEWORK_API_TOKEN=... npx reework-tui
```

#### TUI

The TUI opens on the inbox: **Waiting on you** (open proposals across every conversation) and the
conversations. A status bar shows the agent, the conversation and what it is doing (`running <tool> 12s`,
`thinking…`, `idle`); the footer names the mode and its keys.

| Where                      | Keys                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox                      | ↑↓ select · Enter open (a proposal opens with it focused) · `:N` open conversation N                                                                                |
| Chat (in a conversation)   | type + Enter talks to the agent · ↑↓ recall sent lines · ←→ cursor · PgUp/PgDn scroll · Esc or `:i` inbox                                                           |
| Answer (Tab on a proposal) | ↑↓ option · Enter decide · type + Enter sends an instruction (when accepted) · → open the next attachment, PgUp/PgDn scroll it, ← or Esc fold it · Esc back to chat |
| Anywhere                   | `/help` lists the keys                                                                                                                                              |

Attachments (diffs, test output) stay folded to one line with their size until opened. Nothing is carried
out until you choose an action option.

### Talk to it from code

```ts
import { createClient } from "@reework/client";

const client = createClient({
  baseUrl: "http://127.0.0.1:8080",
  token: process.env.REEWORK_API_TOKEN!,
});
const { id } = await client.createConversation({ key: "release-42" });
await client.submit(id, "Is the worker healthy?");
const [proposal] = await client.listProposals();
await client.decide({ proposalId: proposal.id, selectedOption: "restart", instruction: null });
```

## Writing plugins

The plugin contract, its guarantees (tools may throw, replay, gated actions, workspaces, limits,
shutdown) and the testing kit are in [docs/plugins.md](docs/plugins.md).

## Develop

```sh
pnpm install
pnpm test             # vp test — runs against src via the `reework-source` export condition
pnpm check            # vp check — format, lint, type-check
pnpm build            # tsc → packages/*/dist
pnpm check:packages   # check-dist, publint, attw
pnpm smoke:pack       # pack, install into a clean project with npm, start it, talk to it
```

See `AGENTS.md` for the test policy.
