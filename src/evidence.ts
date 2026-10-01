import { isDeepStrictEqual } from "node:util";
import type { Expectation } from "./probe.ts";

export type NetworkCall = {
  method: string;
  path: string;
  status: number | null;
  requestBody: unknown;
  responseBody: unknown;
  failure?: string;
};

export type DbObservation =
  | { rows: unknown[]; added: unknown[]; removed: unknown[] }
  | { error: string };

// Everything one probe run observed, in a shape that is comparable between
// control and candidate: no ports, no timestamps, no absolute URLs.
export type Evidence = {
  ui: { url: string; captures: Record<string, string | number> };
  network: { calls: NetworkCall[]; last: Record<string, NetworkCall> };
  db: Record<string, DbObservation>;
};

export type ExpectationResult = {
  expectation: Expectation;
  ok: boolean;
  actual: unknown;
  expected: unknown;
  message: string;
};

export type EvidenceDifference = { path: string; control: unknown; candidate: unknown };

type Resolved = { found: true; value: unknown } | { found: false };

const SEGMENT = /\.?([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/y;

// Splits `db.orders.added[0].total_cents` or `network.last["POST /api/orders"].status`.
export function parsePath(path: string): string[] {
  const segments: string[] = [];
  SEGMENT.lastIndex = 0;
  let position = 0;
  while (position < path.length) {
    SEGMENT.lastIndex = position;
    const match = SEGMENT.exec(path);
    if (!match || match[0].length === 0) throw new Error(`Invalid evidence path "${path}" at position ${position}.`);
    segments.push(match[1] ?? match[2] ?? (match[3] as string).replace(/\\(.)/g, "$1"));
    position = SEGMENT.lastIndex;
  }
  if (segments.length === 0) throw new Error("Evidence path is empty.");
  return segments;
}

export function resolvePath(root: unknown, path: string): Resolved {
  let current: unknown = root;
  for (const segment of parsePath(path)) {
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function show(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

export function checkExpectation(evidence: Evidence, expectation: Expectation): ExpectationResult {
  const result = (ok: boolean, actual: unknown, expected: unknown, message: string): ExpectationResult => ({
    expectation,
    ok,
    actual,
    expected,
    message,
  });

  const actual = resolvePath(evidence, expectation.path);
  if (!actual.found) {
    return result(false, undefined, undefined, `${expectation.path} was not observed`);
  }

  if (expectation.equalsPath !== undefined) {
    const other = resolvePath(evidence, expectation.equalsPath);
    if (!other.found) {
      return result(false, actual.value, undefined, `${expectation.equalsPath} was not observed`);
    }
    const ok = isDeepStrictEqual(actual.value, other.value);
    return result(
      ok,
      actual.value,
      other.value,
      `${expectation.path} is ${show(actual.value)}, ${expectation.equalsPath} is ${show(other.value)}`,
    );
  }

  if (expectation.matches !== undefined) {
    const ok = new RegExp(expectation.matches).test(String(actual.value));
    return result(
      ok,
      actual.value,
      expectation.matches,
      `${expectation.path} is ${show(actual.value)}, expected to match /${expectation.matches}/`,
    );
  }

  const ok = isDeepStrictEqual(actual.value, expectation.equals);
  return result(
    ok,
    actual.value,
    expectation.equals,
    `${expectation.path} is ${show(actual.value)}, expected ${show(expectation.equals)}`,
  );
}

function childPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
  if (!plain) return `${base}[${JSON.stringify(key)}]`;
  return base ? `${base}.${key}` : key;
}

// Leaf-level differences between what control and candidate observed.
export function diffEvidence(control: unknown, candidate: unknown, base = ""): EvidenceDifference[] {
  if (isDeepStrictEqual(control, candidate)) return [];

  if (Array.isArray(control) && Array.isArray(candidate)) {
    const differences: EvidenceDifference[] = [];
    for (let i = 0; i < Math.max(control.length, candidate.length); i++) {
      differences.push(...diffEvidence(control[i], candidate[i], childPath(base, i)));
    }
    return differences;
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isRecord(control) && isRecord(candidate)) {
    const keys = [...new Set([...Object.keys(control), ...Object.keys(candidate)])].sort();
    return keys.flatMap((key) => diffEvidence(control[key], candidate[key], childPath(base, key)));
  }

  return [{ path: base, control, candidate }];
}

// "$1,072.50" -> 107250. Integer arithmetic only: money never goes through floats.
export function parseMoney(text: string): number | null {
  const match = /^(-)?\$?(\d[\d,]*)(?:\.(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const dollars = Number((match[2] as string).replaceAll(",", ""));
  const cents = dollars * 100 + Number(match[3] ?? "0");
  return match[1] ? -cents : cents;
}
