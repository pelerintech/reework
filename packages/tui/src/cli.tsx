#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { AgentTui } from "./app.tsx";

const baseUrl = process.env.REEWORK_TUI_URL ?? "http://127.0.0.1:8080";
const token = process.env.REEWORK_API_TOKEN;
if (!token) {
  console.error("reework-tui: set REEWORK_API_TOKEN to the agent's API token");
  process.exit(1);
}

// The TUI is a separate client process: it attaches to a running agent server.
render(<AgentTui baseUrl={baseUrl} token={token} />);
