import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { loadContract } from "./contract.ts";
import { draftContract } from "./draft-contract.ts";
import { killAllServers } from "./env.ts";
import { exec } from "./exec.ts";
import { generate } from "./generate.ts";
import { onPrompt, onStop, readTask, readTaskPrompts } from "./hooks.ts";
import { loadProbes } from "./probe.ts";
import { checkModel, modelConfig } from "./model.ts";
import { HTML_REPORT_FILE, exitCode, renderReport } from "./report.ts";
import { changedFiles, readBaseline, recordBaseline, repoRoot, snapshotWorkingTree } from "./snapshot.ts";
import { defaultHome, replay, verify } from "./verify.ts";

const execution = new AbortController();
let interruptedCode: number | undefined;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const USAGE = `Usage: counterpatch <command> [options]

Commands:
  snapshot   Record the current working tree as the pre-task baseline.
  status     Show the baseline and what has changed since it was recorded.
  check-model  Test the API key and model with a small, source-free request.
  draft-contract  Draft requirements from --prompt or --from-task for review.
  generate   Generate validated probe JSON using a configured model provider.
  verify     Run probes against the baseline (control) and the current
             working tree (candidate) and report where they diverge.
  replay     Rerun the retained snapshots and inputs from --bundle in fresh environments.
  clean      Delete cached environments and past run artifacts.
  hook prompt   Coding-agent hook for a submitted user prompt: logs the prompt
                and records the baseline on the first prompt of a task.
  hook stop     Coding-agent hook for the agent finishing: verifies the task
                and shows the report. Takes --app and --probes like verify.

Options:
  --repo <dir>      Git repository to operate on (default: current directory;
                    for hooks, the session's project directory).
  --app <dir>       App directory inside the repository, containing
                    counterpatch.manifest.json (default: the repository root).
  --probes <path>   Probe file or directory of *.json probes. Repeatable.
  --contract <file> generate/verify/hook stop: versioned task requirements and exclusions.
  --bundle <file>   replay: the saved bundle.json; --repo can locate its Git objects.
  --json            verify/replay: print the full report as JSON instead of text.
  --open            verify/replay: open the report page in the browser when done.
  --prompt <text>   draft-contract/generate: requested changes and behavior to preserve.
  --from-task      draft-contract: use all prompts from the current captured task.
  --model <id>      model commands: provider model ID (or COUNTERPATCH_MODEL).
  --base-url <url>  model commands: API URL (default: OpenRouter; or COUNTERPATCH_BASE_URL).
  --env-file <file> model commands: load model settings from a .env file.
                    File values override shell settings; flags override both.
  --count <n>       generate: maximum probes, 1–10 (default: 5).
  --out <dir>       draft-contract/generate: new output directory (default: inside Git state).
                    --probes supplies optional examples; --json prints generation metadata.

Exit codes for verify/replay: 0 no counterexample discovered, 1 counterexample found,
2 an environment or input failed, 3 verification inconclusive.
With --contract: 0 requirements met by probes, 1 unmet requirements,
3 missing coverage or unverified preservation (unless another requirement failed).

Hook commands read the hook's JSON input on stdin and always exit 0.
check-model exits 0 when the model responds, 2 on configuration or request failure.
draft-contract exits 0 when a draft is ready for review, 3 for open questions or
a changed task, 2 for invalid input or model failure. Drafting never activates a contract.
--json prints its connection details; a JSON-output warning does not fail connectivity.
`;

type HookOptions = { repo?: string; app: string; probes: string[]; contract?: string };

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Hook commands read the hook's JSON input on stdin.");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// The one channel a hook uses to reach the user. Plain stdout from a prompt
// hook would be added to the agent's context, which must not happen.
function tellUser(message: string): void {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

// Never exits 2: Claude Code treats that as "block", which would discard the
// user's prompt or stop the agent from finishing.
async function runHook(event: string | undefined, options: HookOptions): Promise<number> {
  try {
    let input: { cwd?: unknown };
    try {
      input = JSON.parse(await readStdin());
    } catch (error) {
      throw new Error(`Hook input is not valid JSON: ${(error as Error).message}`);
    }
    const sessionDir = typeof input?.cwd === "string" ? input.cwd : process.cwd();
    const root = await repoRoot(path.resolve(options.repo ?? process.env.CLAUDE_PROJECT_DIR ?? sessionDir));

    if (event === "prompt") {
      await onPrompt(root, input);
      return 0;
    }
    if (event === "stop") {
      if (options.probes.length === 0) throw new Error("hook stop needs at least one --probes <file-or-directory>.");
      const { message } = await onStop(root, input, async () =>
        verify({
          repo: root,
          app: options.app,
          probes: await loadProbes(options.probes.map((source) => path.resolve(root, source))),
          signal: execution.signal,
          contract: options.contract ? await loadContract(path.resolve(root, options.contract)) : undefined,
        }),
      );
      if (message) tellUser(message);
      return 0;
    }
    throw new Error(`Unknown hook "${event ?? ""}". Use "hook prompt" or "hook stop".`);
  } catch (error) {
    killAllServers();
    tellUser(`CounterPatch ${event ?? ""} hook failed: ${(error as Error).message}`);
    return 0;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      app: { type: "string", default: "." },
      probes: { type: "string", multiple: true, default: [] },
      contract: { type: "string" },
      bundle: { type: "string" },
      json: { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      prompt: { type: "string" },
      "from-task": { type: "boolean", default: false },
      model: { type: "string" },
      "base-url": { type: "string" },
      "env-file": { type: "string" },
      count: { type: "string", default: "5" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 64;
  }
  if (command === "hook") return runHook(positionals[1], values);
  const repo = path.resolve(values.repo ?? process.cwd());
  const configuredModel = async () => modelConfig(
    { model: values.model, baseUrl: values["base-url"] },
    values["env-file"] ? { ...process.env, ...parseEnv(await fs.readFile(path.resolve(values["env-file"]), "utf8")) } : process.env,
  );

  switch (command) {
    case "draft-contract": {
      if ((values.prompt !== undefined) === values["from-task"]) {
        throw new Error("draft-contract needs exactly one of --prompt <text> or --from-task.");
      }
      const drafted = await draftContract({
        repo, prompt: values.prompt, fromTask: values["from-task"], out: values.out,
        config: await configuredModel(), signal: execution.signal,
        progress: (message) => process.stderr.write(`${message}\n`),
      });
      if (values.json) console.log(JSON.stringify(drafted, null, 2));
      else {
        console.log(`Contract draft: ${drafted.out}`);
        if (drafted.draft.contract) {
          console.log(drafted.draft.contract.title);
          for (const requirement of drafted.draft.contract.requirements) {
            console.log(`  ${requirement.kind} [${requirement.id}] ${requirement.description}`);
            const basis = drafted.draft.basis.find((entry) => entry.requirementId === requirement.id)!;
            for (const quote of basis.quotes) console.log(`    Prompt ${quote.promptIndex}: ${JSON.stringify(quote.quote)}`);
          }
          if (drafted.draft.contract.exclusions.length) {
            console.log("Outside scope:");
            for (const exclusion of drafted.draft.contract.exclusions) console.log(`  ${exclusion}`);
          }
        }
        for (const question of drafted.draft.questions) console.log(`Question to resolve: ${question}`);
        if (drafted.metadata.taskChangedWhileDrafting) console.log("The captured task changed while drafting. Rerun against the latest task before selecting this contract.");
        if (drafted.contractFile) console.log(`Review and edit: ${drafted.contractFile}`);
        if (drafted.metadata.status === "draft" && drafted.contractFile) {
          const settings = [
            values["env-file"] ? ` --env-file ${shellQuote(path.resolve(values["env-file"]))}` : "",
            values.model ? ` --model ${shellQuote(values.model)}` : "",
            values["base-url"] ? ` --base-url ${shellQuote(values["base-url"])}` : "",
          ].join("");
          console.log(`After review: npm run counterpatch -- generate --repo ${shellQuote(repo)} --app ${shellQuote(values.app)} --contract ${shellQuote(drafted.contractFile)}${settings}`);
        }
      }
      return drafted.metadata.status === "draft" ? 0 : 3;
    }
    case "check-model": {
      const config = await configuredModel();
      process.stderr.write(`Checking ${config.baseUrl} with ${config.model} using a fixed test message…\n`);
      const result = await checkModel(config);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log("Connection OK: API key accepted and model responded.");
        console.log(`Requested model: ${result.requestedModel}\nResponding model: ${result.model}`);
        console.log(`JSON check: ${result.jsonOutput ? "passed" : "warning — the model responded without the requested JSON; probe generation may need another model"}`);
        console.log(`Duration: ${result.durationMs} ms; tokens: ${result.usage?.total_tokens ?? "not reported"}`);
      }
      return 0;
    }
    case "generate": {
      const contract = values.contract ? await loadContract(path.resolve(values.contract)) : undefined;
      if (!values.prompt?.trim() && !contract) throw new Error("generate needs --prompt or --contract describing the requested change.");
      const generated = await generate({
        repo, app: values.app, prompt: values.prompt ?? contract!.title, contract,
        config: await configuredModel(),
        count: Number(values.count), out: values.out,
        examples: values.probes.length ? await loadProbes(values.probes.map((source) => path.resolve(source))) : [],
        progress: (message) => process.stderr.write(`${message}\n`),
      });
      if (values.json) console.log(JSON.stringify(generated, null, 2));
      else {
        console.log(`Generated ${generated.metadata.probeIds.length} schema-valid probes (not yet executed).`);
        console.log(`Probes: ${generated.probesDir}`);
        console.log(`Model: ${generated.metadata.model}; ${generated.metadata.durationMs} ms; tokens: ${generated.metadata.usage?.total_tokens ?? "not reported"}`);
        if (generated.metadata.uncoveredRequirementIds?.length) {
          console.log(`Requirements still needing probes: ${generated.metadata.uncoveredRequirementIds.join(", ")}`);
        }
        const contractOption = generated.contractFile ? ` --contract ${shellQuote(generated.contractFile)}` : "";
        console.log(`Run: npm run counterpatch -- verify --repo ${shellQuote(repo)} --app ${shellQuote(values.app)} --probes ${shellQuote(generated.probesDir)}${contractOption} --open`);
      }
      return 0;
    }
    case "snapshot": {
      const root = await repoRoot(repo);
      const previous = await readBaseline(root);
      const baseline = await recordBaseline(root);
      console.log(`Baseline recorded: tree ${baseline.tree.slice(0, 12)} at ${baseline.createdAt}`);
      if (previous) console.log(`Replaced the baseline recorded at ${previous.createdAt}.`);
      return 0;
    }
    case "status": {
      const root = await repoRoot(repo);
      const baseline = await readBaseline(root);
      if (!baseline) {
        console.log('No baseline recorded. Run "counterpatch snapshot" before the coding task starts.');
        return 0;
      }
      const task = await readTask(root);
      if (task) {
        const prompts = await readTaskPrompts(root);
        console.log(`Open task: session ${task.sessionId}, started ${task.startedAt}, ${prompts.length} prompt(s) captured`);
      }
      const changed = await changedFiles(root, baseline.tree, await snapshotWorkingTree(root));
      console.log(`Baseline: tree ${baseline.tree.slice(0, 12)} recorded ${baseline.createdAt}`);
      console.log(changed.length === 0 ? "No changes since the baseline." : `${changed.length} file(s) changed since:`);
      for (const file of changed) console.log(`  ${file.status}  ${file.path}`);
      return 0;
    }
    case "verify":
    case "replay": {
      if (command === "verify" && values.bundle) throw new Error("Use replay --bundle to rerun saved inputs.");
      if (command === "verify" && values.probes.length === 0) throw new Error("verify needs at least one --probes <file-or-directory>.");
      if (command === "replay" && !values.bundle) throw new Error("replay needs --bundle <bundle.json>.");
      if (command === "replay" && (values.probes.length || values.contract || values.app !== ".")) {
        throw new Error("Replay takes its app, probes and contract from the bundle; remove --app, --probes and --contract.");
      }
      const progress = (message: string) => process.stderr.write(`${message}\n`);
      const report = command === "replay" ? await replay({ bundle: path.resolve(values.bundle!),
        repo: values.repo ? repo : undefined, progress, signal: execution.signal }) : await verify({
        repo,
        app: values.app,
        probes: await loadProbes(values.probes.map((source) => path.resolve(source))),
        progress,
        signal: execution.signal,
        contract: values.contract ? await loadContract(path.resolve(values.contract)) : undefined,
      });
      process.stdout.write(
        values.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, process.stdout.isTTY === true),
      );
      if (values.open && (report.outcome === "completed" || report.outcome === "inconclusive")) {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        await exec(opener, [path.join(report.runDir, HTML_REPORT_FILE)]).catch((error: Error) =>
          process.stderr.write(`Could not open the report page: ${error.message}\n`),
        );
      }
      return exitCode(report);
    }
    case "clean": {
      // Only CounterPatch's own subdirectories, in case the home was pointed at a shared directory.
      for (const name of ["envs", "runs"]) {
        const dir = path.join(defaultHome(), name);
        await fs.rm(dir, { recursive: true, force: true });
        console.log(`Removed ${dir}`);
      }
      return 0;
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interruptedCode !== undefined) {
      killAllServers();
      process.exit(interruptedCode);
    }
    interruptedCode = signal === "SIGINT" ? 130 : 143;
    execution.abort();
    killAllServers();
    // Let child exits and preparation finally blocks release their locks.
    // Other commands (for example a pending model request) also remain bounded.
    process.exitCode = interruptedCode;
    setTimeout(() => process.exit(interruptedCode), 10_000).unref();
  });
}

main().then(
  (code) => {
    process.exitCode = interruptedCode ?? code;
  },
  (error: Error) => {
    killAllServers();
    if (interruptedCode === undefined) process.stderr.write(`counterpatch: ${error.message}\n`);
    process.exitCode = interruptedCode ?? 2;
  },
);
