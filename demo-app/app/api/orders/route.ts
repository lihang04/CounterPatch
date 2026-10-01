import { NextResponse } from "next/server";
import { cartLines, cartTotalCents, readCart, writeCart } from "@/lib/cart";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Places an order for the current cart. Guests are allowed: user_id stays NULL.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const lines = cartLines(await readCart());
  if (lines.length === 0) {
    return NextResponse.json({ error: "Your cart is empty." }, { status: 400 });
  }

  const user = await currentUser();
  const totalCents = cartTotalCents(lines);
  const db = getDb();
  const orderId = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO orders (user_id, email, total_cents) VALUES (?, ?, ?)")
      .run(user?.id ?? null, email, totalCents);
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, name, quantity, unit_price_cents)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const line of lines) {
      insertItem.run(lastInsertRowid, line.product.id, line.product.name, line.quantity, line.product.price_cents);
    }
    return Number(lastInsertRowid);
  })();

  await writeCart({});
  return NextResponse.json({ orderId, totalCents }, { status: 201 });
}
