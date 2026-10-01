import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MANIFEST_FILE = "counterpatch.manifest.json";

// The manifest is the app's contract with CounterPatch: how to run it, what
// deterministic fixtures exist, and what can be observed. Probes are written
// against it so nothing about the app has to be guessed.
const ManifestSchema = z.strictObject({
  name: z.string().min(1),
  framework: z.literal("nextjs"),
  commands: z.strictObject({
    install: z.string().min(1),
    build: z.string().min(1).optional(),
    start: z.string().min(1),
    resetDatabase: z.string().min(1),
  }),
  lockfile: z.string().default("package-lock.json"),
  env: z
    .strictObject({
      port: z.string().default("PORT"),
      databasePath: z.string().default("DATABASE_PATH"),
    })
    .default({ port: "PORT", databasePath: "DATABASE_PATH" }),
  readiness: z.strictObject({
    path: z.string().startsWith("/"),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  ui: z
    .strictObject({
      testIdAttribute: z.string().default("data-testid"),
      // Present once the page is interactive; awaited after every full navigation.
      readySelector: z.string().optional(),
    })
    .default({ testIdAttribute: "data-testid" }),
  network: z.strictObject({
    // Same-origin requests whose path starts with one of these are recorded.
    include: z.array(z.string().startsWith("/")).min(1),
  }),
  database: z.strictObject({
    // name -> read-only SELECT. Keep volatile columns (timestamps, tokens) out.
    observables: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1)),
  }),
  routes: z
    .array(
      z.strictObject({
        path: z.string().startsWith("/"),
        kind: z.enum(["page", "api"]),
        methods: z.array(z.string()).optional(),
        description: z.string(),
      }),
    )
    .default([]),
  testUsers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  fixtures: z.record(z.string(), z.unknown()).default({}),
  excludedIntegrations: z.array(z.string()).default([]),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export async function loadManifest(appDir: string): Promise<Manifest> {
  const file = path.join(appDir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`No ${MANIFEST_FILE} found in ${appDir}. CounterPatch needs one to run the app.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
