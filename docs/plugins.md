# Writing plugins

A plugin adds tools, prompt sections and background tasks to an agent. Plugins import only
`@reework/core` (and `@reework/core/testing` in tests), never pi-durable or pi-ai directly, so
framework upgrades do not break them.

## Plugin factory

A plugin is a named factory from its config to what it adds:

```ts
import { Type, defineTool, definePlugin, section } from "@reework/core";

export const tickets = definePlugin("tickets", (config: { baseUrl: string }) => ({
  tools: [
    defineTool({
      name: "get_ticket",
      description: "Read one ticket",
      parameters: Type.Object({ id: Type.String() }),
      execute: async ({ id }) => ({
        output: [{ type: "text", text: await fetchTicket(config.baseUrl, id) }],
      }),
    }),
  ],
  sections: [section("tickets", () => "Tickets live in the tracker; quote their ids.")],
}));
```

The agent declares it with its config: `plugins: [{ plugin: tickets, config: { baseUrl } }]`. The
factory runs once at startup; a throw stops startup naming the plugin. `mission.tools` can narrow
which installed tools the model is offered.

## Tools (may throw)

`execute(args, api, context)` returns `{ output: [...] }`. Arguments are validated against
`parameters` before it runs. A tool may simply **throw**: the model receives an error result with the
message and can react, and surfaces see the call as failed (`isError`). Long work should watch
`context.abortSignal` — it fires when the run is aborted or the agent stops.

## Replay

A tool interrupted by a crash or a stop is, by default, **not** run again: the model gets an
"interrupted" error result and decides what to do. Mark a tool `replay: "safe"` only when running it
twice has the same effect as once (reads, idempotent writes). For effects that must happen once, use
`once` / `onceInCommit` from `@reework/core`, which record a durable receipt.

## Gated actions

`gatedAction({ name, parameters, gate, run })` is a tool that asks a human first. When the model calls
it, a **proposal** opens (title, options, attachments such as a diff, optionally free-form answers) and
the tool tells the model that **nothing has happened yet**. The human decides through any surface; then
`run(ctx, decision, args)` executes and the agent is resumed with the decision and the result as a new
message. `gate` may be a function of the arguments (and may be async, e.g. to compute a diff); it gets
`{ conversationId }`. Gates survive restarts.

## Workspaces

At most one plugin may provide `workspace: { create({ conversationId, key }) → { cwd } }`. Each new
conversation gets its own directory (a clone, a worktree, a temp dir) and the coding tools re-exported
by core act there. Core does not confine paths: wrap tools if you need a hard boundary.

## Setup and the host

`setup({ host, storage, config })` runs once the engine is open — for watchers, schedules or channel
transports. `host` is the in-process protocol (`createConversation({ key })`, `submitInput`,
`listProposals`, `submitDecision`, `snapshot`, `abort`); `storage` is a small durable key-value seam.

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

## Shutdown

`stop({ timeoutMs })` (default 8000 ms) aborts running tools and closes the engine; it rejects if
that takes longer, and releases the storage lock either way. `reework start` exits 0 after a clean
stop, 1 on timeout, and 130 at once on a second SIGINT/SIGTERM. In Docker, keep `stop_grace_period`
above the timeout.

## Testing

`@reework/core/testing` runs an agent hermetically, with no test-runner dependency:

```ts
import {
  startTestAgent,
  text,
  toolCall,
  waitForIdle,
  waitForProposal,
} from "@reework/core/testing";

const { agent, model, dispose } = await startTestAgent(definition);
model.respond([toolCall("get_ticket", { id: "T-1" }), text("T-1 is open")]);
const { id } = await agent.host.createConversation();
await agent.host.submitInput(id, "status of T-1?");
await waitForIdle(agent.host, id);
await dispose();
```

`scriptedModel` replaces the model with a script (`text`, `toolCall`, `toolCalls`);
`waitForProposal` returns the open proposal to decide with `agent.host.submitDecision`.
