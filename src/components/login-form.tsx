"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInWithPassword } from "@/modules/auth/actions";

const FIELD =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.6)] px-3 py-3 text-[14px] text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-accent";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await signInWithPassword({
        email,
        password,
        totpCode: needsTotp ? totpCode : null,
      });
      if (res.ok) {
        // A seeded or reset account lands on Settings to pick a real password.
        router.replace(res.mustChangePassword ? "/settings/security?security=password" : next);
        router.refresh();
        return;
      }
      if (res.needsTotp) {
        setNeedsTotp(true);
        return;
      }
      setError(res.error);
      setTotpCode("");
    });
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-[360px] flex-col gap-3">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          disabled={needsTotp}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD}
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={needsTotp}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={FIELD}
        />
      </div>

      {needsTotp && (
        <div>
          <label htmlFor="totpCode" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Authentication code
          </label>
          <input
            id="totpCode"
            name="totpCode"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            autoFocus
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
            className={`${FIELD} text-center text-[20px] tracking-[0.4em] tabular-nums`}
            data-testid="totp-input"
          />
          <p className="mt-1.5 text-[11.5px] text-muted">
            The 6-digit code from your authenticator app.
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          data-testid="login-error"
          className="rounded-[8px] border border-[rgba(255,107,107,0.35)] bg-[rgba(255,107,107,0.08)] px-3 py-2 text-[12.5px] text-[#FF9B9B]"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 min-h-[44px] rounded-[10px] bg-grad px-4 py-3 text-[14px] font-semibold text-ink shadow-glow transition-opacity disabled:opacity-60"
      >
        {pending ? "Signing in…" : needsTotp ? "Verify" : "Sign in"}
      </button>

      {needsTotp && (
        <button
          type="button"
          onClick={() => {
            setNeedsTotp(false);
            setTotpCode("");
            setError(null);
          }}
          className="min-h-[44px] text-[12.5px] text-muted underline-offset-2 hover:underline"
        >
          Use a different account
        </button>
      )}
    </form>
  );
}
