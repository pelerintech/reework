import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

describe("a lock from another host", () => {
  const heartbeatMs = 60;
  const startFast = (storagePath: string) =>
    startAgent(testDefinition(), {
      storagePath,
      models: fauxModels().models,
      lock: { heartbeatMs },
    });
  const foreignLock = (beat: number) =>
    JSON.stringify({ pid: 4242, host: "other-host", startedAt: 1, beat, heartbeatMs });

  it("is respected while its owner keeps beating", async () => {
    const storagePath = tmpStorage();
    writeFileSync(`${storagePath}.lock`, foreignLock(Date.now()));
    const beating = setInterval(
      () => writeFileSync(`${storagePath}.lock`, foreignLock(Date.now())),
      heartbeatMs / 2,
    );
    try {
      await expect(startFast(storagePath)).rejects.toThrow(/process 4242 on host other-host/);
    } finally {
      clearInterval(beating);
    }
  });

  it("is taken over once its heartbeat stops, whatever the clocks say", async () => {
    const storagePath = tmpStorage();
    // A beat far in the future: a skewed clock must not keep a dead owner alive.
    writeFileSync(`${storagePath}.lock`, foreignLock(Date.now() + 3_600_000));
    const agent = await startFast(storagePath);
    const lock = JSON.parse(readFileSync(`${storagePath}.lock`, "utf8")) as { pid: number };
    expect(lock.pid).toBe(process.pid);
    await agent.stop();
  });

  it("lets exactly one of two racing starters take a stale lock", async () => {
    const storagePath = tmpStorage();
    writeFileSync(`${storagePath}.lock`, foreignLock(1));
    const results = await Promise.allSettled([startFast(storagePath), startFast(storagePath)]);
    const started = results.filter((r) => r.status === "fulfilled");
    expect(started).toHaveLength(1);
    await (
      started[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startFast>>>
    ).value.stop();
  });
});

describe("the owner's heartbeat", () => {
  it("keeps beating while the agent runs", async () => {
    const storagePath = tmpStorage();
    const agent = await startAgent(testDefinition(), {
      storagePath,
      models: fauxModels().models,
      lock: { heartbeatMs: 40 },
    });
    const beat = () =>
      (JSON.parse(readFileSync(`${storagePath}.lock`, "utf8")) as { beat: number }).beat;
    const first = beat();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(beat()).toBeGreaterThan(first);
    await agent.stop();
    expect(existsSync(`${storagePath}.lock`)).toBe(false);
  });
});
