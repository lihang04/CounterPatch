export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: data?.error ?? `Request failed (${response.status}).` };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}
