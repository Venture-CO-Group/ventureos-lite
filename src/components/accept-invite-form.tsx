"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import { submitAcceptPassword, submitAcceptTotp } from "@/modules/members/actions";
import type { AcceptState } from "@/modules/members/accept";

/**
 * The two-step acceptance form (§2).
 *
 * ── WHY TWO-FACTOR IS NOT A "LATER" ─────────────────────────────────────────
 *
 * The spec says the invitee enrols immediately and must not get a first
 * sign-in without it. That is the right shape: 2FA offered later is 2FA half a
 * team never turns on, and the moment somebody is setting up an account is the
 * only moment when adding a step costs nothing socially.
 *
 * The membership becomes ACTIVE only when a code verifies. Until then the
 * invitation stays open — so a closed tab is a resumable interruption rather
 * than a person locked out of a workspace they were invited to.
 */
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent";
const CARD = "rounded-card border border-line bg-panel p-5";

export function AcceptInviteForm({ token, state }: { token: string; state: AcceptState }) {
  const router = useRouter();
  const [step, setStep] = useState<AcceptState["step"]>(state.step);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Somebody who already has a login here.
   *
   * No password step: one person, one login, however many workspaces. They
   * sign in and the invitation is waiting — which is also why this branch does
   * not try to verify an authenticator they already have.
   */
  if (step === "done") {
    return (
      <div className={CARD}>
        <p className="text-[13px] leading-relaxed text-ink" data-testid="invite-signin">
          You already have an account here. Sign in and you will be in{" "}
          {state.workspaceName}.
        </p>
        <a
          href="/login"
          className="mt-3 block rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2.5 text-center text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
        >
          Sign in
        </a>
      </div>
    );
  }

  async function submitPassword() {
    setBusy(true);
    setError(null);
    try {
      const res = await submitAcceptPassword({ token, name, password });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setQr(res.qr);
      setStep("totp");
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await submitAcceptTotp({ token, code });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Straight to the login form: they have a password and an authenticator,
      // and signing them in from here would mean minting a session on an
      // unauthenticated route.
      router.replace("/login?joined=1");
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={CARD}>
      {error && (
        <p role="alert" data-testid="invite-error" className="mb-3 text-[12.5px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      {step === "password" && (
        <div className="grid gap-2.5">
          <label className="grid gap-1">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted">Your name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Anna Kovács"
              data-testid="invite-name"
              className={INPUT}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
              Choose a password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && password && void submitPassword()}
              data-testid="invite-password"
              className={INPUT}
            />
            <span className="text-[11px] text-muted">
              At least {state.minPasswordLength} characters. Nobody else ever sees it —
              not even an Owner.
            </span>
          </label>
          <button
            onClick={() => void submitPassword()}
            disabled={busy || !password}
            data-testid="invite-password-submit"
            className="mt-1 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2.5 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Working…" : "Next: two-factor"}
          </button>
          <p className="text-[11px] leading-relaxed text-muted">
            The next step sets up two-factor authentication. It is required —
            this workspace holds other people&apos;s client data.
          </p>
        </div>
      )}

      {step === "totp" && (
        <div className="grid gap-2.5">
          <p className="text-[12.5px] leading-relaxed text-muted">
            Scan this with an authenticator app (Google Authenticator, 1Password,
            Authy — any of them), then type the six-digit code it shows.
          </p>
          {qr ? (
            <Image
              src={qr}
              alt="Two-factor QR code"
              width={180}
              height={180}
              unoptimized
              data-testid="invite-qr"
              className="mx-auto rounded-[10px] border border-line bg-white p-2"
            />
          ) : (
            <p className="text-[12.5px] text-muted">
              You already set a password. Ask for a fresh invitation link to set
              up your authenticator.
            </p>
          )}
          <label className="grid gap-1">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
              Six-digit code
            </span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && code && void submitCode()}
              data-testid="invite-code"
              className={`${INPUT} text-center text-[18px] tracking-[0.3em] tabular-nums`}
            />
          </label>
          <button
            onClick={() => void submitCode()}
            disabled={busy || code.length < 6}
            data-testid="invite-code-submit"
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2.5 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Checking…" : "Finish and join"}
          </button>
        </div>
      )}
    </div>
  );
}
