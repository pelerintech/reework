# @reework/core

Build durable, human-in-the-loop AI agents on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable).
An agent is a declarative definition plus plugins; reework boots it, keeps its conversations durable in SQLite,
serves an HTTP/WebSocket protocol, and routes risky actions through human approval.

```sh
npm install @reework/core
```

```ts
// agent.ts
import { Type, defineAgent, definePlugin, defineTool, gatedAction } from "@reework/core";

const ops = definePlugin("ops", (config: { service: string }) => ({
  tools: [
    defineTool({
      name: "status",
      description: `Status of ${config.service}`,
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "degraded" }] }),
    }),
    gatedAction({
      name: "restart",
      gate: { title: `Restart ${config.service}?`, options: [{ id: "go", label: "Restart" }] },
      run: async () => "restarted",
    }),
  ],
}));

export default defineAgent({
  name: "ops-agent",
  model: {
    provider: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
    modelId: "gpt-5",
  },
  plugins: [{ plugin: ops, config: { service: "worker" } }],
  channels: [],
  mission: { role: "You keep the worker healthy." },
});
```

```sh
REEWORK_API_TOKEN=change-me OPENAI_API_KEY=... npx reework start agent.ts --port 8080
```

- **Plugins** — tools, prompt sections, a per-conversation workspace; tools may just throw.
- **Gated actions** — a proposal (options, attachments such as a diff) waits for a human; the agent resumes
  with the decision and the result. Survives restarts.
- **Protocol** — keyed conversations, input with dedup, a watch stream (messages, tool calls, proposals),
  token auth; custom routes for webhooks.
- **Run policy** — model limits, an endpoint request cap, a tool-round budget, bounded shutdown.
- **Testing** — `@reework/core/testing`: a scripted model and a disposable agent, no test-runner dependency.

Docs: [architecture](https://github.com/pelerintech/reework/blob/main/docs/architecture.md) · [writing plugins](https://github.com/pelerintech/reework/blob/main/docs/plugins.md) ·
[repository](https://github.com/pelerintech/reework). Clients: [`@reework/client`](https://www.npmjs.com/package/@reework/client),
[`@reework/tui`](https://www.npmjs.com/package/@reework/tui).

MIT
