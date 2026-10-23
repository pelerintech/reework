// Drive the real TUI against a real agent: render it, type keys, read frames.
import React from "react";
import { afterEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { AgentTui } from "@reework/tui";
import type { AgentDefinition } from "@reework/core";
import { startTestAgent } from "@reework/core/testing";
import type { TestAgent } from "@reework/core/testing";

export const KEYS = {
  enter: "\r",
  tab: "\t",
  escape: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  pageUp: "\u001B[5~",
  pageDown: "\u001B[6~",
  backspace: "\u007F",
} as const;

// Rendering a real TUI against a real agent is slower than a unit test, more so under load.
vi.setConfig({ testTimeout: 15_000 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

export interface TuiHarness extends TestAgent {
  frame(): string;
  /** Wait until the rendered frame satisfies `check` (string = contains). */
  waitForFrame(
    check: string | RegExp | ((frame: string) => boolean),
    timeoutMs?: number,
  ): Promise<string>;
  /** Type characters (and key sequences), one write each, letting Ink settle. */
  type(...chunks: string[]): Promise<void>;
  /** Type a line and press Enter. */
  send(line: string): Promise<void>;
}

export async function startTui(
  definition: AgentDefinition,
  options: { rows?: number; noticeMs?: number } = {},
): Promise<TuiHarness> {
  const test = await startTestAgent(definition);
  const server = await test.agent.listen(0);
  const app = render(
    <AgentTui
      baseUrl={`http://127.0.0.1:${server.port}`}
      token={test.token}
      rows={options.rows ?? 30}
      pollMs={100}
      {...(options.noticeMs ? { noticeMs: options.noticeMs } : {})}
    />,
  );
  cleanups.push(async () => {
    app.unmount();
    await server.close();
    await test.dispose();
  });
  // eslint-disable-next-line no-control-regex
  const frame = () => (app.lastFrame() ?? "").replace(/\u001B\[[0-9;]*m/g, "");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) {
      app.stdin.write(chunk);
      await settle();
    }
  };
  return {
    ...test,
    frame,
    type,
    async send(line) {
      await type(...line.split(""), KEYS.enter);
    },
    async waitForFrame(check, timeoutMs = 4000) {
      const ok = (f: string) =>
        typeof check === "string"
          ? f.includes(check)
          : check instanceof RegExp
            ? check.test(f)
            : check(f);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ok(frame())) return frame();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`frame never matched ${String(check)}:\n${frame()}`);
    },
  };
}
