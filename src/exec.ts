import { spawn } from "node:child_process";

export type ExecResult = { stdout: string; stderr: string };

export class ExecError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const detail = (stderr || stdout).trim().split("\n").slice(-15).join("\n");
    super(`Command failed (exit ${code ?? "signal"}): ${command}${detail ? `\n${detail}` : ""}`);
  }
}

// Runs a program with an argument vector (no shell) and captures its output.
export function exec(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`Could not run ${file}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ExecError([file, ...args].join(" "), code, stdout, stderr));
    });
  });
}
