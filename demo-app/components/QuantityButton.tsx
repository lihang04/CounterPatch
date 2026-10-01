"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { postJson } from "./api";

// Sets one product's cart quantity, then re-renders the server components.
export function QuantityButton(props: {
  productId: number;
  quantity: number;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    await postJson("/api/cart", { productId: props.productId, quantity: props.quantity });
    router.refresh();
    setPending(false);
  }

  return (
    <button className={props.className} data-testid={props.testId} disabled={pending} onClick={onClick}>
      {props.children}
    </button>
  );
}
