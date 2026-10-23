// One process owns a storage file at a time. pi-durable has no cross-process
// locking, so the agent writes a lock beside its storage (pattern from
// disler/pi-durable-news-agent), now with the owner's host and a heartbeat so a
// lock from another container or machine on a shared volume can be judged too.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockOptions {
  /** How often the owner refreshes its lock. Default 5000 ms. */
  readonly heartbeatMs?: number;
}

/** What a lock file records. A bare PID is the old format. */
interface LockRecord {
  readonly pid: number;
  readonly host?: string;
  readonly startedAt?: number;
  readonly beat?: number;
  readonly heartbeatMs?: number;
  /** Unique per taking, so a release never removes a lock someone else took since. */
  readonly token?: string;
}

const DEFAULT_HEARTBEAT_MS = 5_000;
/** A foreign owner is watched this many of its heartbeats before it counts as gone. */
const OBSERVE_BEATS = 2.5;

/** Lock files this process took (and still holds). */
const held = new Set<string>();

/**
 * Take the lock at `<storagePath>.lock`; resolves to a release function.
 *
 * - Same host: a lock naming another live PID is refused; one naming this PID is
 *   refused only if this process took it — otherwise a previous process had the same
 *   PID, as every container restart does (the agent is PID 1).
 * - Another host: its liveness is observed, never computed from clocks (hosts' clocks
 *   differ): if its heartbeat changes within a few of its intervals it is alive and
 *   startup is refused; if not, the lock is stale and replaced.
 */
export async function lockStorage(
  storagePath: string,
  options: LockOptions = {},
): Promise<() => void> {
  const path = `${storagePath}.lock`;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const host = hostname();
  const startedAt = Date.now();
  const record = (): LockRecord => ({
    pid: process.pid,
    host,
    startedAt,
    beat: Date.now(),
    heartbeatMs,
    token,
  });
  const take = () => writeFileSync(path, JSON.stringify(record()), { flag: "wx", mode: 0o600 });

  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readLock(path);
    if (existing && (await stillOwned(path, existing, host))) {
      throw new Error(`storage ${storagePath} is already owned by ${describe(existing, host)}`);
    }
    // Stale: remove it and take it exclusively; a racing starter that got there first wins.
    removeIf(path, (current) => sameLock(current, existing));
    try {
      take();
    } catch (raced) {
      if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced;
      const winner = readLock(path);
      throw new Error(
        `storage ${storagePath} is already owned by ${winner ? describe(winner, host) : "another process"}`,
        { cause: raced },
      );
    }
  }
  held.add(path);

  const timer = setInterval(() => {
    const current = readLock(path);
    if (current?.token !== token) return; // no longer ours; never overwrite
    const temp = `${path}.${token}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(record()), { mode: 0o600 });
      renameSync(temp, path);
    } catch {
      // A missed beat is retried on the next tick.
    }
  }, heartbeatMs);
  timer.unref();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    held.delete(path);
    removeIf(path, (current) => current?.token === token);
  };
}

async function stillOwned(path: string, lock: LockRecord, host: string): Promise<boolean> {
  if (lock.host === undefined || lock.host === host) {
    const ours = lock.pid === process.pid;
    return ours ? held.has(path) : isAlive(lock.pid);
  }
  // Another host: watch for its heartbeat to move.
  const interval = lock.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const deadline = Date.now() + interval * OBSERVE_BEATS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval / 2, 1_000)));
    const now = readLock(path);
    if (!now) return false;
    if (!sameLock(now, lock) || now.beat !== lock.beat) return true;
  }
  return false;
}

function readLock(path: string): LockRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return { pid: Number(trimmed) };
  try {
    const parsed = JSON.parse(trimmed) as LockRecord;
    return typeof parsed.pid === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sameLock(a: LockRecord | undefined, b: LockRecord | undefined): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.host === b.host && a.token === b.token && a.startedAt === b.startedAt;
}

function removeIf(path: string, matches: (current: LockRecord | undefined) => boolean): void {
  try {
    if (matches(readLock(path))) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function describe(lock: LockRecord, host: string): string {
  return lock.host && lock.host !== host
    ? `process ${lock.pid} on host ${lock.host}`
    : `process ${lock.pid}`;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
