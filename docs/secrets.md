# Secrets

Plugins and models use secrets without holding them. A secret is declared in the agent definition with how it
is applied and which hosts may receive it; plugins call `ctx.secrets.fetch` to send a request with the secret
applied and `ctx.secrets.get` only where a library needs the raw value. Values live in the agent's process with
the `local` backend, or outside it entirely with the `gateway` backend.

## Declaring secrets

```ts
import { defineAgent } from "@reework/core";

export default defineAgent({
  name: "support",
  model: {
    provider: {
      baseUrl: "https://api.example/v1",
      apiKey: { secret: "llm" },
    },
    modelId: "gpt-5",
  },
  secrets: {
    llm: { from: "env:LLM_KEY" },
    brave: {
      from: "file:/run/secrets/brave",
      apply: { header: "X-Subscription-Token" },
      hosts: ["api.search.example"],
    },
    bot: { from: "env:BOT_TOKEN" },
  },
  // ...plugins, channels, mission
});
```

A definition has three parts:

| Field   | Meaning                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------- |
| `from`  | `env:VAR` or `file:/path`; the local backend reads it, the gateway backend ignores it.             |
| `apply` | `{ header: "Authorization", format?: "Bearer {}" }` or `{ query: "key" }`; how `fetch` applies it. |
| `hosts` | Hostnames that may receive the secret through `fetch`. Required for a fetchable secret.            |

File values are trimmed (leading and trailing whitespace, including a trailing newline) when they are read.

A model-key secret (`apiKey: { secret: "llm" }`) needs no `hosts`, and neither does a secret used only through
`get` (it has no `apply` rule). A secret with `apply` is fetchable and needs a non-empty `hosts`. Startup rejects
an unknown `from` form, an `apply` that does not name exactly one non-empty `header` or `query`, an empty
resolved value, and a fetchable secret without `hosts`, naming the secret and the problem.

Plugins declare what they use:

```ts
definePlugin("search", factory, { secrets: ["brave"] });
```

A declared name must exist in the agent's `secrets`; a plugin that calls `fetch` or `get` for a name it did not
declare is refused, naming the secret.

## `ctx.secrets.fetch` and `ctx.secrets.get`

Every plugin context has `ctx.secrets` — tools, hooks, event hooks, setup, routes and gated actions:

```ts
const response = await ctx.secrets.fetch("brave", "https://api.search.example/v1/search?q=reework");
const body = await response.text(); // the secret value is not in the response object
```

`fetch(name, url, init?)` resolves the named secret, applies it as the definition's header (with `format`, where
`{}` becomes the value) or query parameter, and sends the request with `init` (`method`, `headers`, `body`, …).
It returns the response. The value is never returned to the plugin.

With the local backend the host allow-list is the only URL check — core applies no `checkUrl`, so a secret can
reach a host only when it is in `hosts`; a refused host names the host and the secret. Redirects are followed with
the same check on every hop (up to five), and a hop outside `hosts` is refused without sending the secret there.
With the gateway backend the gateway checks the token, the secret and the host.

For a query secret, core redacts the value in the response URL (`[redacted]`) so `response.url` does not expose
it. An allowed host that echoes the secret in its response body is inside the trust boundary — the host already
has the secret, and core does not inspect bodies.

`get(name)` returns the raw value for a library that cannot take a request; it is audited and should be used
only where unavoidable. Both `get` and `fetch` fire the `onSecretUse` event:

```ts
definePlugin("audit", () => ({
  hooks: {
    async onSecretUse(use) {
      // { plugin, name, kind: "get" | "fetch", at, conversationId? }
    },
  },
}));
```

The event travels through the same per-agent queue as other event hooks; `plugin` is the plugin that used the
secret.

## Model keys

A model provider takes exactly one of `apiKeyEnv` (the environment variable holding the key) or
`apiKey: { secret }` (a declared secret). This holds for the conversation model and every named model; both or
neither fails at startup naming the model and the rule. A model-key secret needs no `hosts`.

```ts
model: {
  provider: { baseUrl: "https://api.example/v1", apiKey: { secret: "llm" } },
  modelId: "gpt-5",
},
models: {
  fast: {
    provider: { baseUrl: "https://api.example/v1", apiKeyEnv: "FAST_KEY" },
    modelId: "small",
  },
},
```

## Backends

`secretsBackend` selects where values live. The default is local.

```ts
secretsBackend: { kind: "local" };
secretsBackend: { kind: "gateway", url: "https://gateway.example", tokenEnv: "BOX_TOKEN" };
```

**Local** reads `env:` and `file:` itself. A declared secret whose env variable or file is missing fails at
startup naming the secret. Model keys come from the same source (`apiKeyEnv` or the secret).

**Gateway** keeps values outside the agent; the box holds only its own token. A missing `tokenEnv` fails at
startup naming the variable. `fetch` and `get` go to the gateway, and model calls use the gateway's upstream
path, so no secret value exists in the agent's process or definition.

## Gateway wire protocol

The URL shape is shared with the gateway plugin. All three routes are under
`<gateway>/plugins/secrets-gateway/open/`; core sends the box token as `Authorization: Bearer <box token>`.

**Proxy a request with a secret applied** — `POST /open/proxy`:

```json
{
  "secret": "brave",
  "url": "https://api.search.example/v1/search?q=reework",
  "method": "GET",
  "headers": { "accept": "application/json" },
  "body": "..."
}
```

The gateway checks the token allows the secret and the URL host is in the secret's `hosts`, applies the value,
forwards the request and returns the upstream response.

**Read a raw value** — `POST /open/raw`:

```json
{ "secret": "bot" }
```

The gateway returns `{ "value": "..." }` only when the token lists that name as raw-allowed (per token, not per
secret); otherwise it refuses with 403.

**Model calls** — the provider `baseUrl` is:

```
<gateway>/plugins/secrets-gateway/open/llm/<upstream>
```

`<upstream>` is the model's name: `main` for the conversation model, or the named model's key (`fast`, `helper`,
…). The provider appends its own protocol path (`/chat/completions` for `openai-completions`, `/v1/messages` for
`anthropic-messages`), so the gateway receives, for example,
`/plugins/secrets-gateway/open/llm/main/chat/completions`. The gateway strips its prefix, forwards the suffix to
the upstream's configured `baseUrl`, and adds only the provider key — never the box token.

## Headless agents

A gateway is a headless agent: `model` is optional. An agent without one serves routes, setup and plugins but
refuses input that would start a run (`cannot start a run: no model configured`). Its gated actions still settle
gates opened before (or independently of) a run, and a decision can run the gated action; a headless agent cannot
open a gate itself because opening needs a run.
