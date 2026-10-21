// One process owns a storage file at a time. pi-durable has no cross-process
// locking, so the agent writes a PID lock beside its storage (pattern from
// disler/pi-durable-news-agent).
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Lock files this process took (and still holds). */
const held = new Set<string>();

/**
 * Take the lock at `path`; returns a release function. A lock naming another live
 * process is refused. A lock naming *this* PID is refused only if this process took
 * it — otherwise it is stale: a previous process had the same PID, as every
 * container restart does (the agent is PID 1).
 */
export function lockStorage(storagePath: string): () => void {
  const path = `${storagePath}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const take = () => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readFileSync(path, "utf8"));
    const ours = pid === process.pid;
    if (ours ? held.has(path) : isAlive(pid)) {
      throw new Error(`storage ${storagePath} is already owned by process ${pid}`);
    }
    unlinkSync(path);
    take();
  }
  held.add(path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(path);
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {
      // Already gone.
    }
  };
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
