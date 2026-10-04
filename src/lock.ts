import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// An exclusive file lock works across separate CLI processes. Hold it until
// all writes finish; cancellation releases it through the same finally path.
export async function withFileLock<T>(
  file: string,
  options: { signal: AbortSignal; timeoutMs: number },
  fn: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  let lock;
  for (;;) {
    options.signal.throwIfAborted();
    try {
      lock = await fs.open(file, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Environment preparation is locked at ${file}. If no run is active, remove the stale lock and retry.`);
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
    }
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    options.signal.throwIfAborted();
    return await fn();
  } finally {
    await lock.close().finally(() => fs.rm(file, { force: true }));
  }
}
