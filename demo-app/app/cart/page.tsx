import Link from "next/link";
import { QuantityButton } from "@/components/QuantityButton";
import { cartLines, cartTotalCents, readCart } from "@/lib/cart";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function CartPage() {
  const lines = cartLines(await readCart());

  if (lines.length === 0) {
    return (
      <>
        <h1>Cart</h1>
        <p data-testid="cart-empty">Your cart is empty.</p>
        <Link href="/">Back to the shop</Link>
      </>
    );
  }

  return (
    <>
      <h1>Cart</h1>
      <table className="lines">
        <tbody>
          {lines.map(({ product, quantity, lineTotalCents }) => (
            <tr key={product.id} data-testid={`cart-line-${product.id}`}>
              <td>{product.name}</td>
              <td className="quantity">
                <QuantityButton productId={product.id} quantity={quantity - 1} testId={`cart-dec-${product.id}`}>
                  −
                </QuantityButton>
                <span data-testid={`cart-qty-${product.id}`}>{quantity}</span>
                <QuantityButton productId={product.id} quantity={quantity + 1} testId={`cart-inc-${product.id}`}>
                  +
                </QuantityButton>
              </td>
              <td className="amount" data-testid={`cart-line-total-${product.id}`}>
                {formatCents(lineTotalCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Total</td>
            <td className="amount" data-testid="cart-total">
              {formatCents(cartTotalCents(lines))}
            </td>
          </tr>
        </tfoot>
      </table>
      <Link href="/checkout" className="button primary" data-testid="go-to-checkout">
        Checkout
      </Link>
    </>
  );
}
