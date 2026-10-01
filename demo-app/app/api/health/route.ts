import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  const { count } = getDb().prepare("SELECT COUNT(*) AS count FROM products").get() as { count: number };
  return NextResponse.json({ ok: true, products: count });
}
