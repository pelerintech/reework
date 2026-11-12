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

## Async factories

A factory may be **async**: startup awaits each factory in declaration order before the engine opens, so a
plugin can connect to a service and discover its tools first. A rejection stops startup with
`plugin "<name>" failed: <message>` and stops the plugins already built. Everything a factory returns is known
before the registry is built, so every tool is registered when the engine opens; there is no dynamic tool
registration after that. A hanging factory is not bounded by core (as a hanging `setup` is not).

```ts
import { Type, definePlugin, defineTool } from "@reework/core";

async function discover(baseUrl: string): Promise<{ name: string; description: string }[]> {
  const response = await fetch(`${baseUrl}/tools`);
  return (await response.json()) as { name: string; description: string }[];
}

export const remote = definePlugin("remote", async (config: { baseUrl: string }) => {
  const discovered = await discover(config.baseUrl);
  return {
    tools: discovered.map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: Type.Object({}),
        execute: async () => `called ${tool.name}`,
      }),
    ),
  };
});
```

## Tool context

A tool's `execute(args, ctx)` receives a reework `ToolContext`:

| Member                             | What it is                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ctx.conversationId`               | The conversation the tool runs in, as a string.                                                                       |
| `ctx.signal`                       | Aborted when the run is stopped or the agent shuts down.                                                              |
| `ctx.output(chunk)`                | Append running output; it becomes the result's output when omitted.                                                   |
| `ctx.models.complete(name, input)` | Call a named model this plugin declared (no retry).                                                                   |
| `ctx.models.embed(name, texts)`    | Embed texts through a named model's OpenAI-compatible `/embeddings` endpoint.                                         |
| `ctx.files.list/read/add`          | The conversation's files (see [Files](#files)).                                                                       |
| `ctx.store`                        | This plugin's storage, agent-wide and per case (see [Plugin storage](#plugin-storage)).                               |
| `ctx.case.get/update`              | The conversation's case (see [Cases](#cases)).                                                                        |
| `ctx.cases.*`                      | Other cases, when the plugin declared `{ cases: true }` (see [Reaching other cases](#reaching-other-cases-ctxcases)). |
| `ctx.once(key, fn)`                | Run `fn` at most once per tool call and key; a replay returns the value.                                              |

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

| Hook                 | It may…                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `beforeTool`         | block the call (`{ block: reason }`) or rewrite its arguments (`{ args }`).                           |
| `afterTool`          | replace a result (`{ output, isError?, details? }`) — e.g. redact text the model sees.                |
| `beforeModelRequest` | rewrite the messages sent to the model (add or redact content), or stop the run (`{ stop: reason }`). |
| `afterModelResponse` | observe every assistant message and its typed `ModelUsage` token counts.                              |
| `beforeModelCall`    | refuse a named-model call (`{ refuse: reason }`); see [Refusing model calls](#refusing-model-calls).  |
| `onModelUsage`       | observe usage of every model call; see [Model usage events](#model-usage-events).                     |
| `onAnswer`           | observe the answer and the input that started the run; return `{ continue }` to keep the run going.   |
| `beforeCompaction`   | supply `{ summary }` or `{ decline: true }` to skip compaction.                                       |

`onAnswer` names the input that started the run: alongside the answer's `text` it receives the
input's `submissionId` and its `from` author (absent when the input was unattributed, never assumed
to be a human).

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

### Input authors on hook messages

In `beforeModelRequest` and `beforeCompaction`, a `user` message carries `from` when the input it came from
was attributed — the same `{ kind, id?, name? }` shape as everywhere else. It is absent for input submitted
without an author, for the compaction summary, and for a message a hook built itself; absent means
unattributed, **never a human**. The field never reaches the model: it is dropped on the way back, so a hook
that returns the messages it received leaves the request byte-identical. Between plugins in declaration order,
a message keeps its author for the next hook only when a hook returns the same message object it was given. A
message a hook built, copied or rewrote has none, and a `from` a hook writes or changes is ignored, so one plugin
cannot relabel input for the plugins after it.
Trust caveat, as in [Authors](#authors): any holder of the API token can claim `kind: "human"`, so `from`
records what the caller declared, not proof.

A hook that presents non-human input to the model as data:

```ts
import { definePlugin } from "@reework/core";
export const wrapExternal = definePlugin("wrap-external", () => ({
  hooks: {
    async beforeModelRequest({ messages }) {
      return {
        messages: messages.map((message) => {
          if (message.role !== "user" || !message.from || message.from.kind === "human") {
            return message;
          }
          const open = `<external kind="${message.from.kind}">`;
          const content =
            typeof message.content === "string"
              ? `${open}${message.content}</external>`
              : [
                  { type: "text" as const, text: open },
                  ...message.content,
                  { type: "text" as const, text: "</external>" },
                ];
          return { role: "user" as const, content };
        }),
      };
    },
  },
}));
```

## External tools

A tool may declare that its output is **outside content** — fetched pages, MCP replies, ingested documents,
channel messages. `defineTool({ …, external: true })` flags the tool; a single result may also mark itself with
`{ output, external: true }` or, when it already carries details, with `details: { reework: { external: true } }`,
even when the tool is not flagged, so a plugin can mark only the passages its own scan flagged. `gatedAction` and
`codingTools()` are never external.

Hooks see the flag as `call.external` (the tool's own flag, in `beforeTool` and `afterTool`) and
`result.external` (true when the tool is flagged, the result said so, or a hook set it). Marking is allowed — a
tool, a result or an `afterTool` hook may set `external: true` on a tool result — but **clearing is impossible
there**: the tool's flag, the result's flag and every hook's flag are OR-ed, so `external: false` or a dropped
field never removes it. A hook that returns a fresh result without `external` keeps it, and a hook that sets
`external: true` on a plain or blocked result makes it stick for the hooks after it. A blocked call's result
starts not external, because no outside content was read; a hook's flag on a blocked result reaches later hooks,
but the stored blocked result carries no flag (pi-durable settles blocked calls itself, and a blocked call
carries no outside content).

Core stores the flag as documented core metadata, `details.reework.external`, beside model usage
(`details.reework.modelUsage`). A hook returning its own `details` keeps both. Later `beforeModelRequest` calls
see `external: true` on the tool-result `ModelMessage` that answers the call. Core re-derives that flag for every
tool-result message handed to the next hook from the stored result **by `toolCallId`**, so a hook cannot clear
it there — even by returning the messages unchanged, dropping the field, or setting `external: false`. A flag a
hook adds to a message itself (rather than to a tool result via `afterTool`) is not sticky: it lasts only for
the next hook's input and is not re-derived from storage. A conversation snapshot's transcript tool item carries
`external: true`, so a surface or audit log can record it.

These guarantees are against **accidental** loss, not against a hostile plugin. Plugins are trusted code: a
plugin declared before another can deliberately strip a tool result's `toolCallId`, re-add it under a different
id, or relabel it as a `user` message; core then cannot match it to the stored result, and the outside text
reaches later hooks (and the model) unflagged. A trust-sensitive plugin such as guardrails must therefore be
declared before any plugin it does not trust to rewrite messages.

Guardrails (a Layer-2 plugin) treats a flagged tool or result as external automatically, in addition to its
`external.tools` config, and wraps/taints it the same way. The flag says the content is untrusted; it does not
change how a tool runs.

## Event hooks

Five hooks cover moments outside a run: `onInput` (input was admitted), `onProposalOpened` (a gate proposal
opened), `onDecision` (a gate proposal was settled), `onCaseClosed` and `onCaseReopened` (a case crossed the
closed boundary). A proposal's `onProposalOpened` is delivered before its `onDecision`. They fire **after** the
commit, from one FIFO queue per agent: one event at a time, plugins in declaration order, each hook awaited.
The caller never waits — a submit or a decide returns as soon as its commit is done — and delivery is **at most
once**, in-process: an event that happens while the process crashes is lost, and nothing is replayed on
restart. A plugin that must not miss a closed case therefore **reconciles in `setup`**: list the cases and
compare them with its own store. Events already queued or running when `agent.stop()` begins are awaited before
plugins stop; new events are dropped without logging. Errors are logged with the plugin's name and the hook.

Their context is a run hook's without `memo`: `conversationId`, `models`, `store`, `files`, `case`. The same queue
also delivers `onModelUsage` (see [Model usage events](#model-usage-events)), whose events for calls outside a
conversation arrive with an agent-level context.

```ts
import { definePlugin } from "@reework/core";

export const journal = definePlugin("journal", () => ({
  hooks: {
    async onInput({ content }, ctx) {
      await ctx.store.case.set("last-input", content);
    },
    async onProposalOpened({ proposal }, ctx) {
      await ctx.store.agent.set(`opened/${proposal.id}`, proposal.title);
    },
    async onDecision({ proposal, decision }, ctx) {
      await ctx.store.agent.set(`decision/${proposal.id}`, decision.selectedOption ?? "none");
    },
    async onCaseClosed({ case: closed }, ctx) {
      await ctx.store.agent.set(`closed/${closed.id}`, true);
    },
    async onCaseReopened({ case: reopened, cause }, ctx) {
      await ctx.store.agent.set(`reopened/${reopened.id}`, cause);
    },
  },
}));
```

## Plugin events

A plugin can announce its own moment with `ctx.emit(name, data)`, and every other plugin that provides
`onPluginEvent(event, ctx)` receives it. `name` is a free-form string the emitting plugin chooses
(`budget.warning`, `secrets-gateway.use`, `library.proposal`), 1–128 printable characters without control
characters; core keeps no registry or schema. `data` must be strict JSON, serialized at most 256 KB — an emit with a
function, a cycle, another non-JSON value or an oversized payload throws, naming the event.

The event is `{ name, data, plugin, conversationId?, at }`: `plugin` is the emitter, and `conversationId` is the
emitting context's conversation (absent from `setup` and routes). Delivery goes through the same per-agent FIFO
queue as the host's event hooks — after the commit, at most once, the caller never waits, consumers in declaration
order, in emit order. A tool call's emits — from its `execute` and from the `beforeTool`/`afterTool` hooks of that
call — are held until the round's tools have committed; a round that is aborted or rolled back discards them, so a
round stopped mid-way loses its emits — delivery is at most once. Emits from other hooks (`beforeModelRequest`,
`afterModelResponse`, `onAnswer`, `beforeCompaction`, and the event hooks) are queued immediately. The emitter never
receives its own event. A reaction chain — a handler emitting in response to an event — is cut at depth 8, and the
dropped emit logs a warning naming the plugin and event.

`emit` is on every plugin context: tools, hooks, event hooks, gated-action gates and runs, `setup` and routes.
Events without a conversation reach consumers with an agent-level context: `conversationId`, `files` and `case`
are absent, and `store.case` is absent too (see [Model usage events](#model-usage-events)).

```ts
import { definePlugin, defineTool, Type } from "@reework/core";

export const budget = definePlugin("budget", () => ({
  tools: [
    defineTool({
      name: "check_budget",
      description: "Check the run's budget.",
      parameters: Type.Object({}),
      async execute(_args, ctx) {
        ctx.emit("budget.warning", { used: 90 });
        return "checked";
      },
    }),
  ],
}));

export const audit = definePlugin("audit", () => ({
  hooks: {
    async onPluginEvent({ name, data, plugin }, ctx) {
      await ctx.store.agent.set(`event/${name}/${plugin}/${Date.now()}`, data);
    },
  },
}));
```

The audit plugin records events in its own reework-plugins request (`audit-plugin-events`); core only carries the
event, so one plugin can announce something and another record it without either knowing the other.

## Stopping a run

A `beforeModelRequest` hook may stop the run instead of rewriting the request: return `{ stop: reason }`. Core makes
no model request for that round (the current stream is never cut — the hook runs before it), ends the run the way
`limits.toolRoundsPerRun` ends one, and records a notice naming the plugin and its reason. The conversation's
snapshot carries it as `stopNotice: { plugin, reason }` (absent when no plugin stopped the run), so a surface can
show "Run stopped by <plugin>: <reason>".

The first stop wins: hooks run in plugin declaration order and the later ones do not run. Input submitted while
the stop is applied is kept (the stop ends the run, not the conversation) and starts a fresh run once the stop
completes. A gate opened before the stop stays open and a decision settles it normally. A hook that throws is
logged and ignored, exactly like any other model-request hook.

```ts
import { definePlugin } from "@reework/core";

export const limiter = definePlugin("limiter", () => ({
  hooks: {
    async beforeModelRequest(_input, ctx) {
      const used = await ctx.store.case.get<number>("tokens");
      if ((used ?? 0) > 200_000) return { stop: "daily token budget reached" };
    },
  },
}));
```

## Model usage events

`onModelUsage` observes every model call that returned usage. A run's main-model response arrives as
`{ source: "run", model: "main", conversationId, usage, at }`; a plugin's named-model call arrives as
`{ source: "plugin", plugin, model, conversationId?, usage, at }`. Named-model events cover calls from a tool, a
hook, a gated action, `setup` and a route. The event carries reework's typed `ModelUsage` token counts (no cost).

Events go through the same per-agent FIFO queue as the other event hooks, after the call's commit, in order with
the conversation-bound events. A call outside a conversation (from `setup` or a route) arrives with an
**agent-level context**: `conversationId`, `files` and `case` are absent, and `store.case` is absent too;
`store.agent` still works. Because delivery is asynchronous, usage totals a plugin keeps are slightly behind a
call made right after — budget plugins document soft limits.

```ts
import { definePlugin } from "@reework/core";

export const meter = definePlugin("meter", () => ({
  hooks: {
    async onModelUsage({ model, conversationId, usage }, ctx) {
      await ctx.store.agent.update(`spent/${model}`, (total) => {
        const spent = (total as number | undefined) ?? 0;
        return spent + usage.totalTokens;
      });
      if (conversationId) await ctx.store.case.set("last-model", model);
    },
  },
}));
```

## Refusing model calls

`beforeModelCall` runs before every `ctx.models.complete` and `ctx.models.embed` — from a tool, hook, gated action, `setup` or a route —
in plugin declaration order. The first `{ refuse: reason }` wins and makes the call throw `ModelCallRefused` with
that reason; no request reaches the model. Its context is agent-level: `conversationId`, `files` and `case` are
absent when the call belongs to no conversation, and `store.case` is absent too. A hook that throws is logged and
ignored, so it never turns into a refusal.

```ts
import { definePlugin } from "@reework/core";

export const budget = definePlugin("budget", () => ({
  hooks: {
    async beforeModelCall({ model }, ctx) {
      const spent = (await ctx.store.agent.get<number>(`spent/${model}`)) ?? 0;
      if (spent > 100_000) return { refuse: "budget" };
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
then `await ctx.models.complete("fast", { messages })` — from a tool or hook, or outside a run from `setup`'s
context (a background loop may keep it for the agent's life) and a route's context. An embedding-capable named
model is called the same way with `ctx.models.embed(name, texts)` (see [Embeddings](#embeddings)). Calls do not retry and carry
the caller's abort signal; outside a run, pass your own `signal` (for example `setup`'s). Usage is recorded on a
tool's result only for calls made by that tool. Each named model has its own request cap (`maxConcurrentRequests`) and its own
catalog entry (`reework.model.<name>`); a model the agent declares but the plugin does not request fails at
the call, while a model the plugin requests but the agent does not declare stops startup. Images are sent only to a model that
declares `input: ["text", "image"]`; a text-only model rejects an image before any request is made.

A tool's named-model spend is recorded on its result: `details.reework.modelUsage` lists every call as
`{ model, inputTokens, outputTokens }`, beside whatever `details` the tool returned, and the aggregate
spend is also attached as the result's `usage` (the conversation's usage ledger). A gated action's `run`
records the same list on its outcome.

## Embeddings

`ctx.models.embed(name, texts, options?)` embeds passages with a named model the plugin declared, from any
context that has `models` (a tool, hook, gated action, `setup` or a route). It returns
`{ embeddings: number[][], usage? }`, one vector per input text in input order. Empty input still resolves the
model and runs `beforeModelCall` (so an undeclared model or a refusal errors), then returns `[]` without a request.

Core calls the model's OpenAI-compatible `POST <baseUrl>/embeddings` endpoint directly (pi-ai has no embedding
operation) with the model's configured key and `{ model: <modelId>, input: <batch> }`. Inputs are sent in
batches of at most 512 per request; their vectors are concatenated in input order and their usage is summed.
Only `openai-completions` and `openai-responses` providers support embeddings; an `anthropic-messages` provider
(or any other `api`) throws `ModelHasNoEmbeddings` naming the model and sends no request.

Each response item is placed by its `index`, so a server may return vectors out of order. A response that does
not fit the request — wrong vector count, missing/duplicate/out-of-range index, missing embedding, a zero-length
vector, an element that is not a finite number, dimensions that differ within or across batches, or a non-JSON
body — throws `EmbeddingResponseInvalid` naming the plugin, the model and the reason; no raw parser error
escapes.

`options.signal` aborts the call and is combined with the context's own signal where one exists (a tool, hook,
gated run, `setup` or route context). The timeout applies **per request**: the gateway backend's `timeoutMs` in
gateway mode, otherwise 60 seconds, so a batched call may take several timeouts before failing; a pending
request fails with `EmbeddingTimeoutError` naming the plugin and model. Embed requests share the model's
`maxConcurrentRequests` limiter with completions, so they queue beside chat calls.

A response's usage is reported through `onModelUsage` like a completion — `source: "plugin"`, the plugin, the
model, the conversation when the call belongs to one, and the summed prompt/total token counts. When only some
batches report usage, the reported counts are summed (no estimate) and one warning naming the plugin and model
is logged. A response without usage still returns its vectors and reports no usage. Embed usage is also recorded
on a tool result's
`details.reework.modelUsage` ledger like completions. `beforeModelCall` runs before embed calls too, so a
`{ refuse }` throws `ModelCallRefused` and nothing is sent. A test's fake embedding endpoint receives the
request's `{ model, input }` and answers the OpenAI shape
(`{ data: [{ index, embedding: [...] }], usage? }`).

```ts
import { Type, definePlugin, defineTool } from "@reework/core";

export const similar = definePlugin(
  "similar",
  () => ({
    tools: [
      defineTool({
        name: "find_similar",
        description: "Embed the query and report its dimensions",
        parameters: Type.Object({ query: Type.String() }),
        async execute({ query }, ctx) {
          const { embeddings, usage } = await ctx.models.embed("embedder", [query], {
            signal: ctx.signal,
          });
          return `${embeddings[0]?.length ?? 0} dimensions; ${usage?.totalTokens ?? 0} tokens`;
        },
      }),
    ],
  }),
  { models: ["embedder"] },
);
```

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

The same store is available in tools, run hooks (`beforeTool`, `afterTool`, `beforeModelRequest`, …), event hooks,
gated actions, `setup` and routes. A tool's writes commit with its call; everywhere else each write commits on its
own, not with the run, so a hook that runs again on a retry should write idempotently (set a value, not append).

## Cases

Every conversation is a **case** or a **desk**. A case is the operator-facing unit; a desk is a
principal's ongoing conversation that routes to many cases. The kind is set at creation and never
changes: `createConversation({ kind: "desk" })` on the host, in the HTTP create body and through
`client.createConversation`; an ordinary conversation is `kind: "case"`, and a record stored before
kinds existed reads as `case`.

A case has `title`, `summary`, `status` (`open` | `waiting` | `closed`), `stage` (an agent-defined
label surfaces show but never interpret), `priority`, `tags`, `dueAt`, `owner`, and derived
`needsHuman` / `openProposals` from its open proposals.

A plugin reads and writes it through `ctx.case`:

```ts fragment
const c = await ctx.case.get();
await ctx.case.update({ stage: "triaged", priority: "high" });
```

A patch is validated field by field (an invalid field is refused naming it). Closing a case with open
proposals is refused; submitting input reopens a closed case; a waiting case stays waiting. The model
may also write the case with the `update_case` tool unless the agent sets `cases.modelTool: false`
(or narrows it with `{ fields }`). Case writes emit `case_updated` and ride the snapshot as `case`.

**Desks.** A desk is otherwise a normal conversation (inputs, runs, tools, proposals), but it stays
out of case listings by default, cannot be closed and is visible to plugins as `kind: "desk"` so
memory, budget, audit and scheduler can treat it correctly. `listCases()` returns cases only;
`listCases({ kind: ["desk"] })` returns desks and `listCases({ kind: ["case", "desk"] })` returns
both. The HTTP list route takes `?kind=` (comma-separated) and the client takes `listCases({ kind })`.
Closing a desk is refused with `cannot close a desk` (HTTP 400; the model's `update_case` tool gets it
as an error result), so `onCaseClosed` never fires for a desk. Input moves a desk exactly as it moves
an ordinary case: `updatedAt` moves, a closed record reopens to `open`, and a waiting desk stays
waiting. A desk differs from a case only in that it cannot be closed.

**Owners.** `owner` is the principal that receives the case's notifications. A principal spans
identities, so its ownership is one stable author — `{ kind, id: "principal:<name>" }` — not each
channel identity. Set it at creation (`createConversation({ case: { owner } })`) or with a patch
(`ctx.case.update({ owner })`, `host.updateCase`, HTTP); it is validated like input authors, appears
on `ctx.case.get()`, snapshots and case events, and `listCases({ owner })` filters by one author (the
HTTP route takes `ownerKind` and `ownerId`, the client takes `listCases({ owner })`).

### Reaching other cases: `ctx.cases`

A desk tool or event hook can reach the agent's other cases when its plugin declares the capability:

```ts
import { definePlugin } from "@reework/core";

export const deskTools = definePlugin(
  "desk-tools",
  () => ({
    tools: [],
    hooks: {
      async onInput(input, ctx) {
        const capability = ctx.cases;
        if (!capability) return;
        const cases = await capability.list({ kind: ["case"] });
        if (cases.length === 0) return;
        await capability.submit(cases[0].id, `desk saw: ${input.content}`, {
          from: { kind: "human", id: "principal:ana" },
        });
      },
    },
  }),
  { cases: true },
);
```

The declaration (`definePlugin(name, factory, { cases: true })`) is the grant and the audit point.
A declared plugin gets `ctx.cases` in tools, event hooks, and gated-action gate/run contexts, scoped to
the agent:

| Member                                                  | What it does                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ctx.cases.list(filter)`                                | The agent's cases with the same filter as `host.listCases`.                            |
| `ctx.cases.get(id)`                                     | One case.                                                                              |
| `ctx.cases.snapshot(id)`                                | A conversation snapshot.                                                               |
| `ctx.cases.submit(id, text, { from })`                  | Submit input attributed to `from`; returns `{ submissionId }`.                         |
| `ctx.cases.decide({ proposalId, decision, decidedBy })` | Settle a proposal as `decidedBy`; `decision` is `{ selectedOption, instruction }`.     |
| `ctx.cases.update(id, patch)`                           | Update a case with the host's validation, including `owner`; desks still cannot close. |

A plugin without the declaration has no `cases` member at all.

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
a diff); it gets `{ conversationId, models, files, store, case }` (plus `cases` when the plugin
declared it). Gates survive restarts.

### Gate audiences

A gated action declares who may decide it: `audience: "human"` (the default) or
`"human-or-agent"`. A gate built from the call's arguments may set its own `audience`, raising a
definition's `human` default (for example when the action is reversible); it is the plugin's own gate,
so no config or manifest ceiling applies. The opened proposal carries the resolved `audience` in
listings, snapshots and proposal events, and a stored proposal without one reads as `human`.

A decision is admitted only when it names a decider its audience admits: a `human` gate admits a human
decider, and a `human-or-agent` gate admits a human or an agent decider. A decision that names no
decider, or names a `system` decider, is refused on both audiences — an agent principal cannot settle a
gate by omitting or mislabelling its attribution. The host throws `GateAudienceRejected`, HTTP decision
routes answer 400 with the audience in the message (`gate audience is human`), and `ctx.cases.decide` —
which goes through `submitDecision` — refuses it too. The refusal happens before the gate settles, so
the proposal stays open.

Attribution is caller-asserted: the API token is the trusted-operator boundary, so a token holder can
assert a human identity, and a channel transport verifies its own identities (a Slack user, a TUI
operator) before passing `decidedBy` through. See [Authors](#authors).

Who the agent deciders are and how a supervisor relays a decision belong to plugins; an
`"human-or-agent"` gate is the seam they use.

Settled proposals stay readable: `host.listProposals({ status: "settled" })`, HTTP
`GET /proposals?status=settled` (and `GET /conversations/:id/proposals?status=settled`), and the
client's `listProposals({ status: "settled" })` return decided proposals with `decidedBy` and the
`decision` that settled them, while the default `listProposals()` still returns open proposals only.
Any other listing status is refused with a 400 naming `open` and `settled`; the host and client throw
the same error rather than falling back to the open listing.

## Workspaces

At most one plugin may provide `workspace: { create({ conversationId, key }) → { cwd } }`. Each new
conversation gets its own directory (a clone, a worktree, a temp dir) and the coding tools re-exported
by core act there. Core does not confine paths: wrap tools if you need a hard boundary.

## Setup and the host

`setup({ host, store, config, signal, dataDir, models })` runs once the engine is open — for watchers, schedules or
channel transports. `models` calls the plugin's named models from that work (see [Named models](#named-models)). `host` is the in-process protocol (`createConversation`, `submitInput`, `getCase`,
`listCases`, `updateCase`, `addFile`, `listFiles`, `readFile`, `listProposals`, `submitDecision`,
`snapshot`, `abort`); `store` is the plugin's durable store; `dataDir` is the plugin's own directory beside the
agent's storage (see [Plugin data directory](#plugin-data-directory)).

## Lifecycle

A plugin may start background work in `setup` and release it on stop. The `signal` a `setup` receives aborts
when the agent begins to stop, so a loop can break out cooperatively; `stop()` releases what the factory or
`setup` opened (timers, sockets, subprocesses) and is awaited. A plugin may use either or both.

On `agent.stop()` the servers close, the signal aborts, queued event hooks drain, and then each built plugin's
`stop()` runs once in **reverse declaration order** — before the engine closes, so a stopping plugin can still
commit. A failing `stop()` is logged as `plugin "<name>" stop failed:` and does not block the others; a stop
that never settles is bounded by the stop timeout, and the error names the plugin still stopping. The same
happens when startup fails after a plugin was built: the signal aborts and the built plugins stop before the
original error is rethrown. `stop()` must tolerate a missing `setup` (a later plugin may have failed).

```ts
import { definePlugin } from "@reework/core";

export const subscriber = definePlugin("subscriber", () => ({
  setup({ host, signal }) {
    const off = host.onCaseUpdated((updated) => {
      // react to a case write
    });
    signal.addEventListener("abort", off, { once: true });
  },
}));
```

## Authors

Every input can record who it is from: `submitInput(id, text, { from })`, the HTTP submit body and
`client.submit` take `from: { kind: "human" | "system" | "agent", id?, name? }` (`id` is stable within the
kind, `name` is displayed). The author is stored on the entry (kind `reework.input`) and appears on messages,
snapshots, `readConversation` and the client view, while the model sees the content unchanged. Gate decisions
carry the same shape as `decidedBy`, and the resumed message names the decider.

Input without an author stays unattributed: **a missing author is never a human**, and a plugin that must
trust the author treats absence as untrusted. An invalid author is refused (`400 invalid_author` over HTTP,
`InvalidAuthor` in-process). Trust caveat: the API token is the trusted-operator boundary, so any holder of it
can claim `kind: "human"`; an author records what the caller declared, not proof, until scoped tokens exist.
Channel transports verify their own identities before passing one through.

```ts
import { definePlugin } from "@reework/core";

export const trust = definePlugin("trust", () => ({
  hooks: {
    async onInput({ from }, ctx) {
      const human = from?.kind === "human";
      await ctx.store.case.set("trusted", human);
    },
  },
}));
```

## Plugin routes

A plugin can mount its own HTTP routes under `/plugins/<name>` by returning `routes(app, ctx)`; paths it
registers are relative to that prefix. Every route needs the API token by default. The only exception is a path
under `/plugins/<name>/open/` (for inbound webhooks), served without the token and announced once at startup with
`[reework] plugin "<name>" serves unauthenticated routes under /plugins/<name>/open/`. There is no other opt-out.
A plugin with routes must have a URL-safe name (`^[a-z0-9][a-z0-9-]*$`). A throwing handler is logged as
`plugin "<name>" route failed:` and answers `500 { "error": "plugin_error", "plugin": "<name>" }`; known protocol
errors such as a missing conversation keep their protocol status. Agent routes (`defineAgent({ routes })`) may not
mount under `/plugins/`.

```ts
import { definePlugin } from "@reework/core";

export const reader = definePlugin("reader", () => ({
  routes(app, ctx) {
    app.get("/events", async (c) => {
      const cursor = await ctx.store.agent.get<string>("cursor");
      return c.json({ cursor: cursor ?? null });
    });
    app.post("/open/inbound", (c) => c.json({ ok: true }));
  },
}));
```

Mounting happens after every `setup` and before `defineAgent.routes` and the engine resumes, so a handler can rely
on what `setup` prepared. `ctx` carries `host`, `store`, `config`, `signal`, `dataDir`, `models` and
`upgradeWebSocket`.

## Plugin WebSockets

A plugin route can accept a WebSocket with `ctx.upgradeWebSocket(factory, limits?)`, using the node WebSocket
instance the agent's server already injects — there is no second listener or port. The route keeps the HTTP rules:
outside `/plugins/<name>/open/` the API token is checked at the handshake (a token-less or wrong-token client sees a
failed handshake and the factory never runs); under `/open/` the plugin gates the handshake itself. The factory
receives the request context and returns the socket's handlers, or a `Response` to refuse the upgrade — so an
`/open/` route verifies its own auth before accepting. A refusal keeps only its status: the upgrade path drops its
body and headers, so a plugin cannot send an explanatory refusal body. The factory may be async.

Handlers use reework shapes: `onOpen(socket)`, `onMessage(data, socket)` with `data` as `string` for text frames and
`Uint8Array` for binary frames, `onClose(code, reason, socket)` and `onError(error, socket)`; `socket` has `send`,
`close` and `readyState`. A request to the route without `Upgrade: websocket` answers
`426 { "error": "websocket_upgrade_required" }`.

Limits apply per upgrade call: `maxMessageBytes` (default 1 MiB) closes an oversized message with code `1009` and
reason `message too big` while it is received; `maxSockets` (default 8) refuses a connection past the plugin's
concurrent count with `429 { "error": "too_many_sockets" }`, and is clamped to the plugin-wide ceiling of 64.
Backpressure is the plugin's business: core bounds a message's acceptance but not a slow reader's outbound buffering,
so a plugin sending large volumes should bound its own.

When the agent stops, open plugin sockets close with code `1001` and reason `agent stopping` before the servers
close, and their close shares the stop deadline; a socket that does not confirm is terminated and named as
`still running: plugin socket "<name>"`. A handler that throws or rejects is logged as
`plugin "<name>" socket failed:` and leaves the socket and the server running.

```ts
import { definePlugin } from "@reework/core";

export const echo = definePlugin("echo", () => ({
  routes(app, ctx) {
    app.get(
      "/echo",
      ctx.upgradeWebSocket(
        (c) => {
          if (c.req.query("secret") !== "let-me-in") return c.json({ error: "unauthorized" }, 401);
          return {
            onOpen(socket) {
              socket.send("hello");
            },
            onMessage(data, socket) {
              socket.send(typeof data === "string" ? data : `bytes:${data.byteLength}`);
            },
            onClose(code, reason) {
              // release per-socket state
            },
          };
        },
        { maxMessageBytes: 65_536, maxSockets: 4 },
      ),
    );
  },
}));
```

The testing kit opens one against a real listener: `openPluginWebSocket(test, "/plugins/echo/echo")` resolves with
`{ socket, port, close() }`, sends the test agent's token and rejects when the handshake is refused.

## Plugin data directory

Every plugin with `setup` or `routes` gets a directory beside the agent's storage file:
`<storagePath>.plugins/<name>/`, created by core before `setup` and persistent across restarts. It is the plugin's
own space for append-only logs or file bundles; core never deletes or rewrites it. A tools-only plugin gets no
directory. Both `setup` and route contexts receive it as `dataDir`.

```ts
import { definePlugin } from "@reework/core";

export const journal = definePlugin("journal", () => ({
  setup({ dataDir }) {
    console.log(`journal files live in ${dataDir}`);
  },
  routes(app, ctx) {
    app.get("/dir", (c) => c.json({ dataDir: ctx.dataDir }));
  },
}));
```

## Custom routes

`defineAgent({ routes: (app, host) => … })` mounts routes such as a webhook next to the built-in API.
They are **not** behind the API token: authenticate them yourself (a shared secret, a signature).
Agent routes may not use the `/plugins/` prefix, which is reserved for plugin routes.
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
