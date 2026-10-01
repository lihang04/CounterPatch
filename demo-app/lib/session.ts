import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getDb, hashPassword, type User } from "./db";

export const SESSION_COOKIE = "session";

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = getDb()
    .prepare(
      `SELECT users.id, users.email, users.name
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`,
    )
    .get(token) as User | undefined;
  return user ?? null;
}

export function verifyCredentials(email: string, password: string): User | null {
  const row = getDb()
    .prepare("SELECT id, email, name, password_salt, password_hash FROM users WHERE email = ?")
    .get(email) as (User & { password_salt: string; password_hash: string }) | undefined;
  if (!row) return null;
  const expected = Buffer.from(row.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, row.password_salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function startSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex");
  getDb().prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
  store.delete(SESSION_COOKIE);
}
