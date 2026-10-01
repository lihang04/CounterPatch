import { cookies } from "next/headers";
import { getDb, type Product } from "./db";

export const CART_COOKIE = "cart";
export const MAX_QUANTITY = 99;

// productId -> quantity. Lives in a cookie so guests need no account.
export type Cart = Record<string, number>;

export type CartLine = { product: Product; quantity: number; lineTotalCents: number };

export function parseCart(raw: string | undefined): Cart {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const cart: Cart = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^\d+$/.test(key)) continue;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_QUANTITY) continue;
    cart[key] = value as number;
  }
  return cart;
}

export async function readCart(): Promise<Cart> {
  return parseCart((await cookies()).get(CART_COOKIE)?.value);
}

export async function writeCart(cart: Cart): Promise<void> {
  const store = await cookies();
  if (Object.keys(cart).length === 0) {
    store.delete(CART_COOKIE);
    return;
  }
  store.set(CART_COOKIE, JSON.stringify(cart), { httpOnly: true, sameSite: "lax", path: "/" });
}

// Prices always come from the database, never from the cookie.
export function cartLines(cart: Cart): CartLine[] {
  const find = getDb().prepare("SELECT id, name, description, price_cents FROM products WHERE id = ?");
  const lines: CartLine[] = [];
  for (const [id, quantity] of Object.entries(cart)) {
    const product = find.get(Number(id)) as Product | undefined;
    if (!product) continue;
    lines.push({ product, quantity, lineTotalCents: product.price_cents * quantity });
  }
  return lines.sort((a, b) => a.product.id - b.product.id);
}

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
}
