import React from "react";
import { render } from "ink";
import { AgentTui } from "./app.tsx";

const baseUrl = process.env.REEWORK_TUI_URL ?? "http://127.0.0.1:8080";
const conversationId = process.env.REEWORK_TUI_CONVERSATION_ID ?? "1";

// The TUI is a separate client process: it attaches to a running agent server.
render(<AgentTui baseUrl={baseUrl} conversationId={conversationId} />);
