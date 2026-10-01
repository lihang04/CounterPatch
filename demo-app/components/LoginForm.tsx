"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "./api";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await postJson("/api/login", { email, password });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <label className="field">
        <span>Email</span>
        <input
          data-testid="login-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          data-testid="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error && (
        <p className="error" data-testid="login-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" data-testid="login-submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
