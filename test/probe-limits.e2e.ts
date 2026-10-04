// Browser execution must use restored limits in waits and failure evidence.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { RunningEnv } from "../src/env.ts";
import { parseManifest } from "../src/manifest.ts";
import { parseProbe } from "../src/probe.ts";
import { runProbe } from "../src/runner.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-limits-"));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><input data-testid="email">');
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const dbPath = path.join(dir, "database.sqlite");
  new Database(dbPath).close();
  const env: RunningEnv = {
    role: "candidate", tree: "test", dir, reused: false,
    baseUrl: `http://127.0.0.1:${address.port}`, dbPath, logPath: path.join(dir, "server.log"),
    manifest: parseManifest({ name: "limits", framework: "nextjs", commands: { install: "true", start: "true", resetDatabase: "true" },
      readiness: { path: "/" }, network: { include: ["/api/"] }, database: { observables: {} } }, "fixture"),
    resetDatabase: async () => {}, stop: async () => {},
  };
  const probe = parseProbe({ id: "missing-control", title: "Missing control", steps: [
    { do: "goto", path: "/" }, { do: "fill", testId: "definitely-missing", value: "test" },
  ], expect: [{ path: "ui.url", equals: "/" }] }, "test");
  browser = await chromium.launch();
  const observed = await runProbe(browser, env, probe, dir, { stepTimeoutMs: 1_000, settleQuietMs: 20 });
  assert.equal(observed.stepFailure?.index, 1);
  assert.match(observed.stepFailure.message, /within 1s/);
  assert.equal(observed.evidence.ui.url, "/");
  assert.ok(observed.screenshot);
  console.log("probe limits e2e: PASS");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
}
