import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { HydrationMarker } from "@/components/HydrationMarker";
import { LogoutButton } from "@/components/LogoutButton";
import { cartCount, readCart } from "@/lib/cart";
import { currentUser } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kettle & Co.",
  description: "CounterPatch demo shop",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [cart, user] = await Promise.all([readCart(), currentUser()]);
  return (
    <html lang="en">
      <body>
        <HydrationMarker />
        <header className="site-header">
          <Link href="/" className="brand">
            Kettle &amp; Co.
          </Link>
          <nav>
            <Link href="/cart" data-testid="nav-cart">
              Cart (<span data-testid="cart-count">{cartCount(cart)}</span>)
            </Link>
            {user ? (
              <>
                <span data-testid="session-user">{user.email}</span>
                <LogoutButton />
              </>
            ) : (
              <Link href="/login" data-testid="nav-login">
                Sign in
              </Link>
            )}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
