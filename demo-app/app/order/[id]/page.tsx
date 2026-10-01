import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, type Order, type OrderItem } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();

  const db = getDb();
  const order = db
    .prepare("SELECT id, user_id, email, total_cents, status FROM orders WHERE id = ?")
    .get(Number(id)) as Order | undefined;
  if (!order) notFound();

  // Account orders are private to their owner. Guest orders have no owner to
  // check against, so the confirmation page is reachable by id.
  if (order.user_id !== null) {
    const user = await currentUser();
    if (user?.id !== order.user_id) notFound();
  }

  const items = db
    .prepare(
      `SELECT id, order_id, product_id, name, quantity, unit_price_cents
       FROM order_items WHERE order_id = ? ORDER BY id`,
    )
    .all(order.id) as OrderItem[];

  return (
    <>
      <h1>
        Order #<span data-testid="order-id">{order.id}</span> confirmed
      </h1>
      <p className="muted">
        A receipt will be sent to <span data-testid="order-email">{order.email}</span>.
      </p>
      <table className="lines">
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td className="quantity">× {item.quantity}</td>
              <td className="amount">{formatCents(item.unit_price_cents * item.quantity)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Total charged</td>
            <td className="amount" data-testid="order-total">
              {formatCents(order.total_cents)}
            </td>
          </tr>
        </tfoot>
      </table>
      <Link href="/">Continue shopping</Link>
    </>
  );
}
