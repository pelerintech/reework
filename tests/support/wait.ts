/** Poll `check` until it returns a truthy value or the timeout passes. */
export async function eventually<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 5000, intervalMs = 20 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`condition not met within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
}
