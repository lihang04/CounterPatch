// Extract JSON without rewriting it. Wrappers are presentation; the caller's
// schema validation decides whether the extracted object is usable.
export function parseModelOutput(content: string, objectKey = "probes"): unknown {
  const output = objectKey === "probes" ? "probe" : "contract draft";
  const hint = objectKey === "probes" ? " or lower --count" : "";
  const unsaved = objectKey === "probes" ? "No probes were saved." : "No contract draft was saved.";
  let text = content.trim();
  // Only remove leading, fully closed reasoning sections. JSON inside an
  // unfinished reasoning section is not a final answer.
  while (/^<think>/i.test(text)) {
    const end = /<\/think>/i.exec(text);
    if (!end) throw new Error(`Model returned unfinished reasoning without a final JSON answer. Increase COUNTERPATCH_MAX_TOKENS${hint}.`);
    text = text.slice(end.index + end[0].length).trimStart();
  }
  try { return JSON.parse(text); } catch { /* Try a JSON object inside presentation text. */ }

  const candidates: unknown[] = [];
  let start = -1;
  let stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (start === -1) {
      if (char === "{" || char === "[") {
        start = i;
        stack = [char];
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) {
        throw new Error(`Model returned malformed JSON delimiters. ${unsaved}`);
      }
      if (stack.length === 0) {
        let value: unknown;
        try { value = JSON.parse(text.slice(start, i + 1)); } catch {
          // Never fix commas, escaping, or quote styles, or recover a nested
          // valid probe from within a malformed batch.
          value = undefined;
        }
        if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, objectKey)) {
          candidates.push(value);
        }
        start = -1;
      }
    }
  }
  if (start !== -1) throw new Error(`Model output contains incomplete JSON. Increase COUNTERPATCH_MAX_TOKENS${hint}. ${unsaved}`);
  if (candidates.length > 1) throw new Error(`Model returned multiple ${output} objects; the final answer is ambiguous. ${unsaved}`);
  if (candidates.length === 1) return candidates[0];
  throw new Error(`Model output contains no valid JSON ${output} object. ${unsaved}`);
}
