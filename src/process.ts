import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
const live = new Set<ChildProcess>();
const operations = new Set<AbortController>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Shells, npm, and their children all belong to this detached group.
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}

export function registerOperation(controller: AbortController): () => void {
  operations.add(controller);
  return () => { operations.delete(controller); };
}

export function killAllProcesses(): void {
  for (const controller of operations) controller.abort();
  for (const child of live) killGroup(child, "SIGKILL");
}

export function spawnLoggedProcess(options: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; logPath: string; signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const log = createWriteStream(options.logPath, { flags: "a" });
  log.write(`\n$ ${options.command}\n`);
  const child = spawn(options.command, {
    cwd: options.cwd, env: options.env, shell: true, detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let error: Error | undefined;
  let closed = false;
  const abort = () => killGroup(child, "SIGKILL");
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (cause) => { error = cause; });
  log.on("error", (cause) => { error = cause; abort(); });
  // A shell can exit while a background descendant holds the output pipes.
  // Clean up the entire group rather than waiting forever for those pipes.
  child.once("exit", abort);
  const finished = new Promise<ProcessExit>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      live.delete(child);
      options.signal?.removeEventListener("abort", abort);
      const done = () => resolve({ code, signal, error });
      if (log.destroyed) done();
      else log.end(done);
    });
  });
  const stop = async () => {
    if (closed) return;
    killGroup(child, "SIGTERM");
    const forced = setTimeout(abort, 5_000);
    try { await finished; } finally { clearTimeout(forced); }
  };
  return { child, finished, stop, kill: abort };
}

export async function runLoggedCommand(options: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; logPath: string;
  timeoutMs: number; signal?: AbortSignal;
}): Promise<void> {
  const running = spawnLoggedProcess(options);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    running.kill();
  }, options.timeoutMs);
  try {
    const exit = await running.finished;
    if (timedOut) throw new Error(`"${options.command}" timed out after ${options.timeoutMs} ms.`);
    if (options.signal?.aborted) throw new Error(`"${options.command}" was cancelled.`);
    if (exit.error) throw new Error(`Could not run "${options.command}": ${exit.error.message}`);
    if (exit.code !== 0) throw new Error(`"${options.command}" exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}.`);
  } finally {
    clearTimeout(timeout);
  }
}
