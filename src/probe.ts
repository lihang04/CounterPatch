import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parsePath } from "./evidence.ts";

// Probes are data, not code: a fixed vocabulary of browser steps plus
// expectations over the collected evidence. That keeps generated probes
// (hand-written today, model-written later) validatable before they run.
const StepSchema = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("goto"), path: z.string().startsWith("/") }),
  z.strictObject({ do: z.literal("click"), testId: z.string().min(1) }),
  z.strictObject({ do: z.literal("fill"), testId: z.string().min(1), value: z.string() }),
  // `path` is matched against the URL pathname; "*" matches one path segment.
  z.strictObject({ do: z.literal("waitForUrl"), path: z.string().startsWith("/") }),
  z.strictObject({ do: z.literal("waitFor"), testId: z.string().min(1), text: z.string().optional() }),
  z.strictObject({
    do: z.literal("capture"),
    testId: z.string().min(1),
    as: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
    // "money" turns "$72.00" into 7200 so it can be compared with stored cents.
    parse: z.enum(["text", "number", "money"]).default("text"),
  }),
]);

const JsonValue: z.ZodType<unknown> = z.json();

const EvidencePathSchema = z.string().min(1).refine((value) => {
  try {
    parsePath(value);
    return true;
  } catch {
    return false;
  }
}, { message: "Invalid evidence path." });

const RegexSchema = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, { message: "Invalid regular expression." });

const ExpectationSchema = z
  .strictObject({
    // Path into the evidence, e.g. `db.orders.added[0].total_cents`.
    path: EvidencePathSchema,
    equals: JsonValue.optional(),
    matches: RegexSchema.optional(),
    equalsPath: EvidencePathSchema.optional(),
    description: z.string().optional(),
  })
  .refine(
    (e) => [e.equals !== undefined, e.matches !== undefined, e.equalsPath !== undefined].filter(Boolean).length === 1,
    { message: 'Exactly one of "equals", "matches" or "equalsPath" is required.' },
  );

const ProbeSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().optional(),
  requirementId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  // Exercises behaviour that only exists after the change, so there is no
  // baseline to validate the probe against. Reported separately.
  candidateOnly: z.boolean().default(false),
  steps: z.array(StepSchema).min(1),
  expect: z.array(ExpectationSchema).min(1),
});

export type Step = z.infer<typeof StepSchema>;
export type Expectation = z.infer<typeof ExpectationSchema>;
export type Probe = z.infer<typeof ProbeSchema>;

// The same structural schema is sent to the generator; parseProbe also checks
// refinements (valid evidence paths, regexes, and exactly one comparison).
export function probeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProbeSchema, { io: "input" });
}

export function parseProbe(json: unknown, source: string): Probe {
  const parsed = ProbeSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Probe ${source} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

// Loads probes from files and/or directories of *.json files.
export async function loadProbes(sources: string[]): Promise<Probe[]> {
  const files: string[] = [];
  for (const source of sources) {
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) throw new Error(`Probe path ${source} does not exist.`);
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(source)).filter((name) => name.endsWith(".json")).sort();
      files.push(...entries.map((name) => path.join(source, name)));
    } else {
      files.push(source);
    }
  }
  if (files.length === 0) throw new Error(`No probe files (*.json) found in: ${sources.join(", ")}`);

  const probes: Probe[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      throw new Error(`Probe ${file} is not valid JSON: ${(error as Error).message}`);
    }
    const probe = parseProbe(json, file);
    const previous = seen.get(probe.id);
    if (previous) throw new Error(`Probe id "${probe.id}" is used by both ${previous} and ${file}.`);
    seen.set(probe.id, file);
    probes.push(probe);
  }
  return probes;
}
