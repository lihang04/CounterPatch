"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "./api";

export function CheckoutForm(props: { defaultEmail: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(props.defaultEmail);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await postJson<{ orderId: number }>("/api/orders", { email });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    router.push(`/order/${result.data.orderId}`);
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <label className="field">
        <span>Email for the receipt</span>
        <input
          data-testid="checkout-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />
      </label>
      {error && (
        <p className="error" data-testid="checkout-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" data-testid="place-order" disabled={pending}>
        {pending ? "Placing order…" : "Place order"}
      </button>
    </form>
  );
}
