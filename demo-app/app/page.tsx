import { QuantityButton } from "@/components/QuantityButton";
import { readCart } from "@/lib/cart";
import { getDb, type Product } from "@/lib/db";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = getDb()
    .prepare("SELECT id, name, description, price_cents FROM products ORDER BY id")
    .all() as Product[];
  const cart = await readCart();

  return (
    <>
      <h1>Shop</h1>
      <ul className="products">
        {products.map((product) => {
          const inCart = cart[String(product.id)] ?? 0;
          return (
            <li key={product.id} className="card" data-testid={`product-${product.id}`}>
              <h2>{product.name}</h2>
              <p className="muted">{product.description}</p>
              <p className="price" data-testid={`product-price-${product.id}`}>
                {formatCents(product.price_cents)}
              </p>
              <QuantityButton
                className="primary"
                productId={product.id}
                quantity={inCart + 1}
                testId={`add-to-cart-${product.id}`}
              >
                Add to cart
              </QuantityButton>
              {inCart > 0 && (
                <p className="muted">
                  In cart: <span data-testid={`in-cart-${product.id}`}>{inCart}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
