import Link from "next/link";
import { CheckoutForm } from "@/components/CheckoutForm";
import { cartLines, cartTotalCents, readCart } from "@/lib/cart";
import { formatCents } from "@/lib/money";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const [cart, user] = await Promise.all([readCart(), currentUser()]);
  const lines = cartLines(cart);

  if (lines.length === 0) {
    return (
      <>
        <h1>Checkout</h1>
        <p data-testid="checkout-empty">Your cart is empty.</p>
        <Link href="/">Back to the shop</Link>
      </>
    );
  }

  return (
    <>
      <h1>Checkout</h1>
      <p className="muted" data-testid="checkout-mode">
        {user ? `Signed in as ${user.email}` : "Checking out as a guest"}
      </p>
      <table className="lines">
        <tbody>
          {lines.map(({ product, quantity, lineTotalCents }) => (
            <tr key={product.id}>
              <td>{product.name}</td>
              <td className="quantity">× {quantity}</td>
              <td className="amount">{formatCents(lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Total</td>
            <td className="amount" data-testid="checkout-total">
              {formatCents(cartTotalCents(lines))}
            </td>
          </tr>
        </tfoot>
      </table>
      <CheckoutForm defaultEmail={user?.email ?? ""} />
    </>
  );
}
