# @reework/client

Client for [reework](https://github.com/pelerintech/reework) agents: every protocol route over REST, the watch
stream over WebSocket, and a pure conversation view model to render from.

```ts
import { applyFrame, createClient, emptyView } from "@reework/client";

const client = createClient({
  baseUrl: "http://127.0.0.1:8080",
  token: process.env.REEWORK_API_TOKEN!,
});
const { id } = await client.createConversation({ key: "ticket-42" });

let view = emptyView(id);
const watch = await client.watch(id, (frame) => {
  view = applyFrame(view, frame); // messages, tool calls with status, running, proposals
});

await client.submit(id, "What is the status of ticket 42?");
const [proposal] = await client.listProposals({ conversationId: id });
if (proposal)
  await client.decide({ proposalId: proposal.id, selectedOption: "go", instruction: null });
watch.close();
```

Docs: [architecture](https://github.com/pelerintech/reework/blob/main/docs/architecture.md). MIT
