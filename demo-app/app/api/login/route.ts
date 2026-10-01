import { NextResponse } from "next/server";
import { startSession, verifyCredentials } from "@/lib/session";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  if (typeof body?.email !== "string" || typeof body?.password !== "string") {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  const user = verifyCredentials(body.email.trim(), body.password);
  if (!user) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }
  await startSession(user.id);
  return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
}
