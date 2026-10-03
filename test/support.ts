import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloneDir } from "../src/env.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(here, "..");
export const fixtures = path.join(here, "fixtures");
export const shopProbes = path.join(projectRoot, "probes", "shop");

const demoApp = path.join(projectRoot, "demo-app");
const SKIP = new Set(["node_modules", ".next", "data", "next-env.d.ts", "tsconfig.tsbuildinfo"]);

// Copies the demo sources and checkout modules into a temporary repository.
// Verification still installs its own dependencies in each snapshot environment.
export async function copyDemoShop(dest: string): Promise<void> {
  assert.ok(
    await fs.stat(path.join(demoApp, "node_modules")).catch(() => null),
    'demo-app/node_modules is missing; run "npm install" in demo-app first.',
  );
  await fs.cp(demoApp, dest, { recursive: true, filter: (source) => !SKIP.has(path.basename(source)) });
  await cloneDir(path.join(demoApp, "node_modules"), path.join(dest, "node_modules"));
}
