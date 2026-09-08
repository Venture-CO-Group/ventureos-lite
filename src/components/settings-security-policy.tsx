"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import { setRequire2fa, type SecurityPolicyView } from "@/modules/workspaces/actions";

/**
 * Two-factor authentication, for everybody (P5/5.1).
 *
 * TOTP existed — enrolment, QR code, Owner reset — and was entirely optional
 * per person. There was no way to say "in this workspace, everybody", and for a
 * system holding other people's client data that is the usual expectation. The
 * field that makes it work, `User.mustEnrollTotp`, was already there with
 * nothing to set it.
 */
export function SettingsSecurityPolicy({ view }: { view: SecurityPolicyView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await setRequire2fa(next);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(
        next
          ? res.pending > 0
            ? `On. ${res.pending} ${res.pending === 1 ? "person" : "people"} will be asked to register an authenticator on their next click.`
            : "On. Everybody already has one."
          : "Off. Nobody's authenticator was removed.",
      );
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]" id="security-policy">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Security policy
      </div>
      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        Applies to everybody in this workspace, on top of whatever each person
        has set for themselves.
      </p>

      {note && (
        <p
          data-testid="security-policy-note"
          className="mb-3 rounded-[8px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] px-3 py-2 text-[12px] text-[#8CEFC0]"
        >
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      <label className="flex items-start gap-2.5 rounded-[10px] border border-line bg-panel-2 px-3 py-2.5">
        <input
          type="checkbox"
          checked={view.require2fa}
          disabled={!view.canEdit || busy}
          onChange={(e) => void toggle(e.target.checked)}
          data-testid="require-2fa"
          style={{ accentColor: "#7427C6" }}
          className="mt-[3px]"
        />
        <span className="min-w-0">
          <b className="block text-[12.5px]">Require two-factor authentication</b>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
            Anybody without an authenticator is sent to the enrolment screen on
            their next click. That is enrolment, not a lockout — they register
            one and carry on, and nobody is signed out. Turning it off later
            removes nobody&apos;s authenticator.
          </span>
        </span>
      </label>

      <p className="mt-2 text-[11.5px] text-muted">
        {view.pending === 0 ? (
          <>
            All {view.members} {view.members === 1 ? "member" : "members"} have an
            authenticator registered.
          </>
        ) : (
          <span data-testid="pending-2fa">
            <b className="text-warn">{view.pending}</b> of {view.members}{" "}
            {view.members === 1 ? "member has" : "members have"} no authenticator
            yet
            {view.require2fa
              ? " — they will be asked to register one."
              : "; they would each be asked to register one."}
          </span>
        )}
      </p>

      {!view.canEdit && (
        <p className="mt-2 text-[12px] text-muted">
          Read-only — only an Owner can change the security policy.
        </p>
      )}
    </div>
  );
}
