# @reework/tui

Terminal operator console for [reework](https://github.com/pelerintech/reework) agents.

```sh
REEWORK_TUI_URL=http://127.0.0.1:8080 REEWORK_API_TOKEN=... npx @reework/tui
```

- **Inbox** — what waits on you (open proposals across every conversation) and the conversations; ↑↓ Enter.
- **Chat** — the transcript with tool calls and their timing; a status bar shows what the agent is doing.
- **Answer** — Tab focuses a proposal: ↑↓ option, Enter decide, or type an instruction; → opens an attachment
  (diff, test output) in a scrollable pane.
- `/help` lists every key.

MIT
