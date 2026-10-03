import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { exitCode, renderReport } from "./report.ts";
import { recordBaseline, stateDir } from "./snapshot.ts";
import type { Report } from "./verify.ts";

// Handlers for coding-agent session hooks. They capture what the user asked
// for and the pre-task working tree without the agent's involvement, and run
// verification when the agent says it is finished.

const PromptInput = z.object({ session_id: z.string().min(1), prompt: z.string() });
const StopInput = z.object({ session_id: z.string().min(1) });

const TaskSchema = z.strictObject({
  sessionId: z.string(),
  startedAt: z.string(),
  baseline: z.string(),
  // Optional to read tasks created before revisions were introduced.
  revision: z.string().optional(),
});

const PromptSchema = z.strictObject({ at: z.string(), sessionId: z.string(), prompt: z.string() });

// The unit of verification: everything a session changes from its first prompt
// until a verification finds no counterexample. One task per repository.
export type Task = z.infer<typeof TaskSchema>;
export type CapturedPrompt = z.infer<typeof PromptSchema>;

function parseInput<T>(schema: z.ZodType<T>, input: unknown, event: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Unexpected ${event} hook input:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function taskFile(root: string): Promise<string> {
  return path.join(await stateDir(root), "task.json");
}

async function promptsFile(root: string): Promise<string> {
  return path.join(await stateDir(root), "prompts.jsonl");
}

// Serialize state changes across hook processes, but let verification run
// without the lock so a new prompt can start or extend a task meanwhile.
async function withTaskLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = await stateDir(root);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "task.lock");
  const deadline = Date.now() + 30_000;
  let lock;
  for (;;) {
    try {
      lock = await fs.open(file, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Task state is locked at ${file}. If no hook is running, remove the stale lock and retry.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await lock.close();
    await fs.rm(file, { force: true });
  }
}

async function writeTask(root: string, task: Task): Promise<void> {
  const file = await taskFile(root);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readTask(root: string): Promise<Task | null> {
  const raw = await fs.readFile(await taskFile(root), "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = TaskSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${await taskFile(root)} is corrupt:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// The user's own words for the open task, in order: the input for intent reconstruction.
export async function readTaskPrompts(root: string): Promise<CapturedPrompt[]> {
  const task = await readTask(root);
  if (!task) return [];
  const raw = await fs.readFile(await promptsFile(root), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => PromptSchema.parse(JSON.parse(line)))
    .filter((entry) => entry.sessionId === task.sessionId && entry.at >= task.startedAt);
}

// UserPromptSubmit: log the prompt and, on the first prompt of a task, record
// the baseline before the agent has touched anything.
export async function onPrompt(root: string, input: unknown): Promise<{ startedTask: boolean }> {
  const { session_id: sessionId, prompt } = parseInput(PromptInput, input, "UserPromptSubmit");
  return withTaskLock(root, async () => {
    const at = new Date().toISOString();
    const task = await readTask(root);
    const startedTask = task === null || task.sessionId !== sessionId;
    const next: Task = startedTask
      ? { sessionId, startedAt: at, baseline: (await recordBaseline(root)).commit }
      : task;

    // Prompts can contain anything the user typed; keep the log private to them.
    await fs.appendFile(await promptsFile(root), `${JSON.stringify({ at, sessionId, prompt })}\n`, { mode: 0o600 });
    // Even a follow-up changes the task: a verification already in flight
    // has not checked the work requested by this new prompt.
    await writeTask(root, { ...next, revision: randomUUID() });
    return { startedTask };
  });
}

// Stop: verify the open task. Returns the text to show the user, or null when
// there is nothing to say (no task for this session, or nothing changed).
export async function onStop(
  root: string,
  input: unknown,
  runVerify: () => Promise<Report>,
): Promise<{ message: string | null; report: Report | null }> {
  const { session_id: sessionId } = parseInput(StopInput, input, "Stop");
  const task = await readTask(root);
  if (!task || task.sessionId !== sessionId) return { message: null, report: null };

  const report = await runVerify();
  if (report.outcome === "unchanged") return { message: null, report };

  // A clean result ends the task, so the next prompt is judged against the
  // tree as it is now. Anything else keeps the original "before".
  if (exitCode(report) === 0) {
    await withTaskLock(root, async () => {
      const current = await readTask(root);
      if (isDeepStrictEqual(current, task) && report.baseline.commit === task.baseline) {
        await fs.rm(await taskFile(root), { force: true });
      }
    });
  }
  return { message: renderReport(report, false), report };
}
