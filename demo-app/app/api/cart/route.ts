import { NextResponse } from "next/server";
import { MAX_QUANTITY, cartCount, cartLines, cartTotalCents, readCart, writeCart } from "@/lib/cart";
import { getDb } from "@/lib/db";

// Sets the quantity of one product in the cart; quantity 0 removes it.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { productId?: unknown; quantity?: unknown } | null;
  const productId = body?.productId;
  const quantity = body?.quantity;
  if (!Number.isInteger(productId) || !Number.isInteger(quantity)) {
    return NextResponse.json({ error: "productId and quantity must be integers." }, { status: 400 });
  }
  if ((quantity as number) < 0 || (quantity as number) > MAX_QUANTITY) {
    return NextResponse.json({ error: `quantity must be between 0 and ${MAX_QUANTITY}.` }, { status: 400 });
  }
  const exists = getDb().prepare("SELECT 1 FROM products WHERE id = ?").get(productId);
  if (!exists) {
    return NextResponse.json({ error: `Unknown product ${productId}.` }, { status: 404 });
  }

  const cart = await readCart();
  if (quantity === 0) delete cart[String(productId)];
  else cart[String(productId)] = quantity as number;
  await writeCart(cart);

  const lines = cartLines(cart);
  return NextResponse.json({
    items: lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
    count: cartCount(cart),
    totalCents: cartTotalCents(lines),
  });
}
