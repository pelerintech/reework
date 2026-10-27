# Writing plugins

A plugin adds tools, prompt sections, hooks and setup to an agent. Plugins import only
`@reework/core` (and `@reework/core/testing` in tests), never pi-durable or pi-ai directly, so
framework upgrades do not break them. The facade re-exports `Type` and the tool/context shapes, so a
plugin sees reework's contract, not pi-durable's.

## Plugin factory

A plugin is a named factory from its config to what it adds:

```ts
import { Type, defineTool, definePlugin, section } from "@reework/core";

async function fetchTicket(baseUrl: string, id: string): Promise<string> {
  const response = await fetch(`${baseUrl}/tickets/${id}`);
  return response.text();
}

export const tickets = definePlugin("tickets", (config: { baseUrl: string }) => ({
  tools: [
    defineTool({
      name: "get_ticket",
      description: "Read one ticket",
      parameters: Type.Object({ id: Type.String() }),
      execute: async ({ id }, ctx) => fetchTicket(config.baseUrl, id),
    }),
  ],
  sections: [section("tickets", () => "Tickets live in the tracker; quote their ids.")],
}));
```

The agent declares it with its config: `plugins: [{ plugin: tickets, config: { baseUrl } }]`. The
factory runs once at startup; a throw stops startup naming the plugin. `mission.tools` can narrow
which installed tools the model is offered. A plugin may also declare the named models it calls:
`definePlugin("tickets", factory, { models: ["fast"] })`.

## Tool context

A tool's `execute(args, ctx)` receives a reework `ToolContext`:

| Member                             | What it is                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `ctx.conversationId`               | The conversation the tool runs in, as a string.                                         |
| `ctx.signal`                       | Aborted when the run is stopped or the agent shuts down.                                |
| `ctx.output(chunk)`                | Append running output; it becomes the result's output when omitted.                     |
| `ctx.models.complete(name, input)` | Call a named model this plugin declared (no retry).                                     |
| `ctx.files.list/read/add`          | The conversation's files (see [Files](#files)).                                         |
| `ctx.store`                        | This plugin's storage, agent-wide and per case (see [Plugin storage](#plugin-storage)). |
| `ctx.case.get/update`              | The conversation's case (see [Cases](#cases)).                                          |
| `ctx.once(key, fn)`                | Run `fn` at most once per tool call and key; a replay returns the value.                |

A tool returns a string (the model sees it) or a `ToolResult` `{ output, isError?, details? }`.

## Tools (may throw)

Arguments are validated against `parameters` before the tool runs. A tool may simply **throw**: the
model receives an error result with the message and can react, and surfaces see the call as failed.
Long work should watch `ctx.signal` — it fires when the run is aborted or the agent stops. Only
`defineTool`, `gatedAction` and `codingTools()` produce accepted tools; a hand-made object fails
startup naming the plugin.

## Replay

A tool interrupted by a crash or a stop is, by default, **not** run again: the model gets an
"interrupted" error result and decides what to do. Mark a tool `replay: "safe"` only when running it
twice has the same effect as once (reads, idempotent writes). For effects that must happen once, use
`ctx.once` in a tool, or `once` / `onceInCommit` from the unstable `@reework/core/internal` entry in
framework code, which record a durable receipt.

## Hooks

A plugin may observe and shape the run. Hooks run in **plugin declaration order**; each gets a
`PluginHookContext` (`conversationId`, `models`, `store`, `files`, `case`, and `memo(name, fn)` — a
value computed once per task attempt and reused on retry).

| Hook                 | It may…                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `beforeTool`         | block the call (`{ block: reason }`) or rewrite its arguments (`{ args }`).            |
| `afterTool`          | replace a result (`{ output, isError?, details? }`) — e.g. redact text the model sees. |
| `beforeModelRequest` | rewrite the messages sent to the model (add or redact content).                        |
| `afterModelResponse` | observe every assistant message and its usage.                                         |
| `onAnswer`           | observe the answer to an input; return `{ continue }` to keep the run going.           |
| `beforeCompaction`   | supply `{ summary }` or `{ decline: true }` to skip compaction.                        |

**Error rules.** A `beforeTool` that throws **blocks** the call. Any other hook that throws is
logged and skipped — it never fails the run. pi-durable does not run `afterTool` for a blocked call;
the facade reports a blocked call to the `afterTool` hooks of the plugins declared after the blocker,
so an audit plugin sees every call either way.

A guardrail plugin: block a destructive tool unless the case says it is safe.

```ts
import { definePlugin } from "@reework/core";

export const guard = definePlugin("guard", () => ({
  hooks: {
    async beforeTool({ name }, ctx) {
      if (name === "delete_repo") {
        const c = await ctx.case.get();
        if (c.stage !== "approved") return { block: "repo deletion needs an approved case" };
      }
    },
  },
}));
```

## Named models

An agent may declare extra models beside the conversation model:

```ts fragment
models: {
  fast: { provider: { baseUrl: "https://api.example/v1", apiKeyEnv: "FAST_KEY" }, modelId: "small" },
}
```

`main` is reserved. A plugin calls only models it declared: `definePlugin(name, factory, { models: ["fast"] })`,
then `await ctx.models.complete("fast", { messages })` (from a tool or hook). Calls do not retry and carry
the caller's abort signal. Each named model has its own request cap (`maxConcurrentRequests`) and its own
catalog entry (`reework.model.<name>`); a model the agent declares but the plugin does not request fails at
the call, while a model the plugin requests but the agent does not declare stops startup. Images are sent only to a model that
declares `input: ["text", "image"]`; a text-only model rejects an image before any request is made.

A tool's named-model spend is recorded on its result: `details.reework.modelUsage` lists every call as
`{ model, inputTokens, outputTokens }`, beside whatever `details` the tool returned, and the aggregate
spend is also attached as the result's `usage` (the conversation's usage ledger). A gated action's `run`
records the same list on its outcome.

## Plugin storage

`ctx.store` is a real durable store, namespaced per plugin, in two scopes:

```ts fragment
await ctx.store.agent.set("cursor", 42); // agent-wide
await ctx.store.case.set("lastSeen", now); // this conversation
const cursor = await ctx.store.agent.get<number>("cursor");
const items = await ctx.store.agent.list("cursor"); // { key, value }[] — keys with that prefix
```

`agent` and `case` are separate scopes; each plugin's keys are its own namespace. `update(key, fn)`
reads, applies `fn`, and writes atomically. Plugins never see the raw storage seam.

## Cases

Every conversation is a **case** — the operator-facing unit. A case has `title`, `summary`, `status`
(`open` | `waiting` | `closed`), `stage` (an agent-defined label surfaces show but never interpret),
`priority`, `tags`, `dueAt`, and derived `needsHuman` / `openProposals` from its open proposals.

A plugin reads and writes it through `ctx.case`:

```ts fragment
const c = await ctx.case.get();
await ctx.case.update({ stage: "triaged", priority: "high" });
```

A patch is validated field by field (an invalid field is refused naming it). Closing a case with open
proposals is refused; submitting input reopens a closed case; a waiting case stays waiting. The model
may also write the case with the `update_case` tool unless the agent sets `cases.modelTool: false`
(or narrows it with `{ fields }`). Case writes emit `case_updated` and ride the snapshot as `case`.

## Files

Files are stored beside the agent's storage, content-addressed by sha256, and listed per conversation.
A plugin reads and adds them through `ctx.files`:

```ts fragment
const { bytes } = await ctx.files.read(id); // bytes of a file in this conversation
const record = await ctx.files.add({
  // a `plugin`-source file
  name: "report.txt",
  mimeType: "text/plain",
  bytes,
});
```

`ctx.files.add` respects `files.maxBytes` (default 10 MiB); a larger file throws. A gated action may
attach a file with `{ kind: "file", fileId }`; a file from another conversation fails the gate before
any proposal opens.

## Gated actions

`gatedAction({ name, parameters, gate, run })` is a tool that asks a human first. When the model calls
it, a **proposal** opens (title, options, attachments such as a diff or a file, optionally free-form
answers) and the tool tells the model that **nothing has happened yet**. The human decides through any
surface; then `run(ctx, decision, args)` executes and the agent is resumed with the decision and the
result as a new message. `gate` may be a function of the arguments (and may be async, e.g. to compute
a diff); it gets `{ conversationId, models, files, store, case }`. Gates survive restarts.

## Workspaces

At most one plugin may provide `workspace: { create({ conversationId, key }) → { cwd } }`. Each new
conversation gets its own directory (a clone, a worktree, a temp dir) and the coding tools re-exported
by core act there. Core does not confine paths: wrap tools if you need a hard boundary.

## Setup and the host

`setup({ host, store, config })` runs once the engine is open — for watchers, schedules or channel
transports. `host` is the in-process protocol (`createConversation`, `submitInput`, `getCase`,
`listCases`, `updateCase`, `addFile`, `listFiles`, `readFile`, `listProposals`, `submitDecision`,
`snapshot`, `abort`); `store` is the plugin's durable store.

## Custom routes

`defineAgent({ routes: (app, host) => … })` mounts routes such as a webhook next to the built-in API.
They are **not** behind the API token: authenticate them yourself (a shared secret, a signature).
Create one conversation per subject with `createConversation({ key })` and deduplicate deliveries
with `submitInput(id, text, { requestId })`.

## Limits

- `model.contextWindow` / `model.maxTokens` — the endpoint's real limits (defaults 128000 / 8192);
  compaction follows the window.
- `model.maxConcurrentRequests` — at most this many requests in flight to the endpoint; others wait.
- `limits.toolRoundsPerRun` — past this many tool rounds since the latest user input, tool calls are
  refused and the model is told to answer with what it has; if it keeps calling tools, the run ends.
- `files.maxBytes` — the largest file the agent stores (default 10 MiB).

## Shutdown

`stop({ timeoutMs })` (default 8000 ms) aborts running tools and closes the engine; it rejects if
that takes longer, and releases the storage lock either way. `reework start` exits 0 after a clean
stop, 1 on timeout, and 130 at once on a second SIGINT/SIGTERM. In Docker, keep `stop_grace_period`
above the timeout.

## Testing

`@reework/core/testing` runs an agent hermetically, with no test-runner dependency:

```ts fragment
import {
  startTestAgent,
  text,
  toolCall,
  offeredTools,
  addFile,
  waitForIdle,
  waitForProposal,
} from "@reework/core/testing";

const test = await startTestAgent(definition);
test.model.respond([toolCall("get_ticket", { id: "T-1" }), text("T-1 is open")]);
const { id } = await test.agent.host.createConversation();
const tools = offeredTools(test, id); // names and parameter schemas offered to the model
await test.agent.host.submitInput(id, "status of T-1?");
await waitForIdle(test.agent.host, id);
await test.dispose();
```

`scriptedModel` replaces the model with a script (`text`, `toolCall`, `toolCalls`); `test.models.<name>`
is a scripted model for each declared named model; `addFile` uploads bytes through the host;
`waitForProposal` returns the open proposal to decide with `agent.host.submitDecision`.

The unstable escape hatch `@reework/core/internal` (the `Engine`, the storage seam) is for the
framework's own tests only — agent projects must not import it.
