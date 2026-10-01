#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so it works from any working directory.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const result = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
