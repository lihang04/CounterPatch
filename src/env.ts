import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { exec } from "./exec.ts";
import { loadManifest, type Manifest } from "./manifest.ts";
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

const live = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Servers are started through a shell and npm; signal the whole group.
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

export function killAllServers(): void {
  for (const child of live) killGroup(child, "SIGKILL");
  live.clear();
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

function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, logPath: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`\n$ ${command}\n`);
    const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", reject);
    child.on("close", (code) => log.end(() => resolve(code)));
  });
}

function appEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Colour is switched off so captured build and server logs stay readable.
  return { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
}

// Materializes one snapshot tree into a directory, installs dependencies and
// builds it. Directories are keyed by tree id, so the control side of a repair
// loop (same baseline, new candidate) is built once and reused.
export async function prepareEnv(options: {
  role: Role;
  repoRoot: string;
  tree: string;
  home: string;
}): Promise<PreparedEnv> {
  const { role, tree } = options;
  const envsDir = path.join(options.home, "envs");
  const dir = path.join(envsDir, tree);
  const readyMarker = path.join(envsDir, `${tree}.ready`);
  const logPath = path.join(envsDir, `${tree}.prepare.log`);

  // Older cache entries may contain unverified checkout dependencies.
  const prepareVersion = "2";
  if ((await fs.readFile(readyMarker, "utf8").catch(() => null)) === prepareVersion && (await exists(dir))) {
    return { role, tree, dir, manifest: await loadManifest(dir), reused: true };
  }

  // No marker means a previous preparation did not finish; start clean.
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(logPath, { force: true });
  await fs.mkdir(envsDir, { recursive: true });
  await materializeTree(options.repoRoot, tree, dir);
  const manifest = await loadManifest(dir);

  const fail = async (phase: "install" | "build", command: string, code: number | null) =>
    new EnvError(role, phase, `${role}: "${command}" exited with code ${code}.`, logPath, await tail(logPath));

  // Matching lockfiles do not prove the checkout's node_modules is current.
  // Install from the snapshot itself; only completed environments are reused.
  const code = await runShell(manifest.commands.install, dir, appEnv(), logPath);
  if (code !== 0) throw await fail("install", manifest.commands.install, code);

  if (manifest.commands.build) {
    const code = await runShell(manifest.commands.build, dir, appEnv(), logPath);
    if (code !== 0) throw await fail("build", manifest.commands.build, code);
  }

  await fs.writeFile(readyMarker, prepareVersion);
  return { role, tree, dir, manifest, reused: false };
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

async function waitUntilReady(url: string, timeoutMs: number, child: ChildProcess): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return "exited";
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return "ready";
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return "timeout";
}

// Starts a prepared app on its own port with its own database file.
export async function startEnv(prepared: PreparedEnv, runDir: string): Promise<RunningEnv> {
  const { role, manifest, dir } = prepared;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(runDir, `${role}.sqlite`);
  const logPath = path.join(runDir, `${role}.server.log`);
  const env = appEnv({
    [manifest.env.port]: String(port),
    [manifest.env.databasePath]: dbPath,
  });

  const resetDatabase = async () => {
    const code = await runShell(manifest.commands.resetDatabase, dir, env, logPath);
    if (code !== 0) {
      throw new EnvError(
        role,
        "reset-database",
        `${role}: "${manifest.commands.resetDatabase}" exited with code ${code}.`,
        logPath,
        await tail(logPath),
      );
    }
  };
  await resetDatabase();

  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n$ ${manifest.commands.start}\n`);
  const child = spawn(manifest.commands.start, {
    cwd: dir,
    env,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  live.add(child);
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  void exited.then(() => {
    live.delete(child);
    log.end();
  });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, "SIGTERM");
      const forced = setTimeout(() => killGroup(child, "SIGKILL"), 5_000);
      await exited;
      clearTimeout(forced);
    }
  };

  const state = await waitUntilReady(`${baseUrl}${manifest.readiness.path}`, manifest.readiness.timeoutMs, child);
  if (state !== "ready") {
    await stop();
    const reason =
      state === "exited"
        ? `"${manifest.commands.start}" exited before becoming ready`
        : `${manifest.readiness.path} did not return 2xx within ${manifest.readiness.timeoutMs} ms`;
    throw new EnvError(role, "start", `${role}: ${reason}.`, logPath, await tail(logPath));
  }

  return { ...prepared, baseUrl, dbPath, logPath, resetDatabase, stop };
}
