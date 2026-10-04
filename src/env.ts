import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exec } from "./exec.ts";
import { withFileLock } from "./lock.ts";
import { loadManifest, type Manifest } from "./manifest.ts";
import { killAllProcesses, registerOperation, runLoggedCommand, spawnLoggedProcess } from "./process.ts";
import { materializeTree } from "./snapshot.ts";

export type Role = "control" | "candidate";

export type PreparedEnv = { role: Role; tree: string; dir: string; manifest: Manifest; reused: boolean };

export type RunningEnv = PreparedEnv & {
  baseUrl: string;
  dbPath: string;
  logPath: string;
  resetDatabase(): Promise<void>;
  stop(): Promise<void>;
};

// A failure to install, build or start one side. Not a crash: "the candidate
// no longer builds" is itself a result worth reporting.
export class EnvError extends Error {
  constructor(
    readonly role: Role,
    readonly phase: "install" | "build" | "reset-database" | "start",
    message: string,
    readonly logPath: string,
    readonly logTail: string,
  ) {
    super(message);
  }
}

// Retain the public name; cleanup now includes every environment command.
export function killAllServers(): void {
  killAllProcesses();
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function tail(file: string, lines = 25): Promise<string> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  // Some build tools colour their code frames even with NO_COLOR set.
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  return plain.trimEnd().split("\n").slice(-lines).join("\n");
}

// Copy-on-write where the filesystem supports it (APFS, btrfs, xfs), plain copy otherwise.
export async function cloneDir(source: string, dest: string): Promise<void> {
  const flags = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
  try {
    await exec("cp", [...flags, source, dest]);
  } catch {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(source, dest, { recursive: true, verbatimSymlinks: true });
  }
}

function appEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Colour is switched off so captured build and server logs stay readable.
  return { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
}

async function runPhase(options: {
  role: Role; phase: "install" | "build" | "reset-database";
  command: string; cwd: string; env: NodeJS.ProcessEnv; logPath: string;
  timeoutMs: number; signal: AbortSignal;
}): Promise<void> {
  try {
    await runLoggedCommand(options);
  } catch (error) {
    throw new EnvError(options.role, options.phase, `${options.role}: ${(error as Error).message}`,
      options.logPath, await tail(options.logPath));
  }
}

// Materializes one snapshot tree into a directory, installs dependencies and
// builds it. Directories are keyed by tree id, so the control side of a repair
// loop (same baseline, new candidate) is built once and reused.
export async function prepareEnv(options: {
  role: Role;
  repoRoot: string;
  tree: string;
  home: string;
  signal?: AbortSignal;
  lockTimeoutMs?: number;
}): Promise<PreparedEnv> {
  const { role, tree } = options;
  const envsDir = path.resolve(options.home, "envs");
  const dir = path.join(envsDir, tree);
  const readyMarker = path.join(envsDir, `${tree}.ready`);
  const logPath = path.join(envsDir, `${tree}.prepare.log`);

  const controller = new AbortController();
  const unregister = registerOperation(controller);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    return await withFileLock(path.join(envsDir, `${tree}.lock`), {
      signal, timeoutMs: options.lockTimeoutMs ?? 900_000,
    }, async () => {
      // Older entries were prepared without build-time database isolation.
      const prepareVersion = "3";
      if ((await fs.readFile(readyMarker, "utf8").catch(() => null)) === prepareVersion && (await exists(dir))) {
        return { role, tree, dir, manifest: await loadManifest(dir), reused: true };
      }

      await fs.rm(readyMarker, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(logPath, { force: true });
      await materializeTree(options.repoRoot, tree, dir);
      signal.throwIfAborted();
      const manifest = await loadManifest(dir);
      const env = appEnv({
        [manifest.env.databasePath]: path.join(dir, ".counterpatch-build.sqlite"),
        [manifest.env.port]: "0",
      });
      const common = { role, cwd: dir, env, logPath, signal };
      await runPhase({ ...common, phase: "install", command: manifest.commands.install, timeoutMs: manifest.timeouts.installMs });
      if (manifest.commands.build) {
        // A build can execute database-backed pages. Seed its own database
        // after installation, before any build-time application code runs.
        await runPhase({ ...common, phase: "reset-database", command: manifest.commands.resetDatabase, timeoutMs: manifest.timeouts.resetDatabaseMs });
        await runPhase({ ...common, phase: "build", command: manifest.commands.build, timeoutMs: manifest.timeouts.buildMs });
      }
      signal.throwIfAborted();
      // Keep the canonical build path stable, publishing readiness atomically.
      const temporary = `${readyMarker}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, prepareVersion);
        await fs.rename(temporary, readyMarker);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return { role, tree, dir, manifest, reused: false };
    });
  } finally {
    unregister();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port"))));
    });
  });
}

async function waitUntilReady(url: string, timeoutMs: number, child: ChildProcess, signal: AbortSignal): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return "exited";
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now())))]) });
      if (response.ok) return "ready";
    } catch {
      // Not listening yet.
    }
    await delay(150, undefined, { signal });
  }
  return "timeout";
}

// Starts a prepared app on its own port with its own database file.
export async function startEnv(prepared: PreparedEnv, runDir: string, parentSignal?: AbortSignal): Promise<RunningEnv> {
  const { role, manifest, dir } = prepared;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(runDir, `${role}.sqlite`);
  const logPath = path.join(runDir, `${role}.server.log`);
  const env = appEnv({
    [manifest.env.port]: String(port),
    [manifest.env.databasePath]: dbPath,
  });

  const controller = new AbortController();
  const unregister = registerOperation(controller);
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const resetDatabase = () => runPhase({
    role, phase: "reset-database", command: manifest.commands.resetDatabase,
    cwd: dir, env, logPath, signal, timeoutMs: manifest.timeouts.resetDatabaseMs,
  });
  let server: ReturnType<typeof spawnLoggedProcess> | undefined;
  try {
    await resetDatabase();
    server = spawnLoggedProcess({ command: manifest.commands.start, cwd: dir, env, logPath, signal });
    void server.finished.then(unregister);
    const state = await waitUntilReady(`${baseUrl}${manifest.readiness.path}`, manifest.readiness.timeoutMs, server.child, signal);
    if (state !== "ready") {
      const reason = state === "exited"
        ? `"${manifest.commands.start}" exited before becoming ready`
        : `${manifest.readiness.path} did not return 2xx within ${manifest.readiness.timeoutMs} ms`;
      throw new Error(reason);
    }
    return { ...prepared, baseUrl, dbPath, logPath, resetDatabase, stop: server.stop };
  } catch (error) {
    await server?.stop();
    unregister();
    if (error instanceof EnvError) throw error;
    throw new EnvError(role, "start", `${role}: ${(error as Error).message}`, logPath, await tail(logPath));
  }
}
