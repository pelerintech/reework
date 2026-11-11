// Ending a run from a hook: abort it and wait for its generation to end. Shared by
// the tool-round budget and a plugin's `beforeModelRequest` stop, so both end a run
// the same way (the current request is never cut mid-stream — a hook runs before it).

/** How long a generation waits for its run's abort before going on regardless. */
export const ABORT_GRACE_MS = 5_000;

/** Resolve when `signal` aborts (rejecting with its reason) or after `ms`. */
export function abortedOr(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Abort a run and wait for its generation to end. `abort` is not awaited: the
 * caller runs inside the generation it ends, so waiting for its own task would
 * deadlock; its runtime signal ends the request phase instead.
 */
export async function endRun(
  abort: () => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  void abort().catch(() => {});
  await abortedOr(signal, ABORT_GRACE_MS);
}
