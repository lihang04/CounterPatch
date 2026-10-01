"use client";

import { useRouter } from "next/navigation";
import { postJson } from "./api";

export function LogoutButton() {
  const router = useRouter();

  async function onClick() {
    await postJson("/api/logout", {});
    router.push("/");
    router.refresh();
  }

  return (
    <button className="link" data-testid="logout" onClick={onClick}>
      Sign out
    </button>
  );
}
