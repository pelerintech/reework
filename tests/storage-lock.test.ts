import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startAgent } from "@reework/core";
import { fauxModels, testDefinition, tmpStorage } from "./support/agent.ts";

const start = (storagePath: string) =>
  startAgent(testDefinition(), { storagePath, models: fauxModels().models });

describe("one process owns a storage file", () => {
  it("refuses a storage file locked by another live process, and takes over a stale lock", async () => {
    const storagePath = tmpStorage();
    const other = spawn("sleep", ["30"]);
    writeFileSync(`${storagePath}.lock`, String(other.pid));

    await expect(start(storagePath)).rejects.toThrow(new RegExp(`process ${other.pid}`));

    other.kill();
    await new Promise((resolve) => other.once("exit", resolve));
    const agent = await start(storagePath);
    await agent.stop();
  });

  it("releases its lock on stop so the next start succeeds", async () => {
    const storagePath = tmpStorage();
    const first = await start(storagePath);
    expect(existsSync(`${storagePath}.lock`)).toBe(true);
    await expect(start(storagePath)).rejects.toThrow(/already owned/);

    await first.stop();
    expect(existsSync(`${storagePath}.lock`)).toBe(false);
    const second = await start(storagePath);
    await second.stop();
  });

  it("takes over a lock left by a previous process that had the same PID (container restart)", async () => {
    // In a container the agent is always PID 1: after a crash, the stale lock names the
    // PID the restarted process has too. Only a lock this process took is really held.
    const storagePath = tmpStorage();
    writeFileSync(`${storagePath}.lock`, String(process.pid));

    const agent = await start(storagePath);
    await expect(start(storagePath)).rejects.toThrow(/already owned/);
    await agent.stop();
  });
});
