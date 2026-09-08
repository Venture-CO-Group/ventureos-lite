"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  deleteUserAccount,
  previewRoleChange,
  requestMemberEmailChange,
  resetMemberTotp,
  restoreUserAccount,
  setMemberSuspended,
  transferOwnership,
  updateMemberProfile,
} from "@/modules/members/admin-actions";
import { MemberRemoveFlow } from "./member-remove-flow";
import type { ManagedUser } from "@/modules/users/actions";

/**
 * Everything an Owner can do to one member (§4).
 *
 * ── WHY THESE LIVE TOGETHER ─────────────────────────────────────────────────
 *
 * They share a shape: each is consequential, each needs its own confirmation
 * semantics, and each writes to the timeline. Scattering them across the table
 * row, the edit modal and the drawer is how the product ended up with three
 * different weights of confirmation for three actions of the same severity.
 *
 * The severities differ and the controls say so. A profile edit saves on a
 * button. A 2FA reset demands a written reason. Ownership transfer asks for a
 * password and a code. Removal is a four-step flow of its own.
 */
const BTN =
  "min-h-[32px] rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";
const SECTION = "grid gap-2 rounded-[11px] border border-line p-3";

export function MemberActions({
  user,
  candidates,
  teams,
}: {
  user: ManagedUser;
  candidates: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [removing, setRemoving] = useState(false);

  // profile
  const [name, setName] = useState(user.name);
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [timezone, setTimezone] = useState("");
  const [locale, setLocale] = useState("");

  // the consequential ones
  const [newEmail, setNewEmail] = useState("");
  const [totpReason, setTotpReason] = useState("");
  const [rolePreview, setRolePreview] = useState<{
    gains: string[];
    loses: string[];
    identical: boolean;
  } | null>(null);
  const [previewRole, setPreviewRole] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferPassword, setTransferPassword] = useState("");
  const [transferCode, setTransferCode] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [deleteReason, setDeleteReason] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await fn();
        setMsg(res.ok ? { kind: "ok", text: ok } : { kind: "err", text: res.error ?? "Failed." });
        if (res.ok) router.refresh();
      } catch (e) {
        setMsg({ kind: "err", text: serverActionError(e) });
      }
    });
  }

  return (
    <div className="grid gap-3" data-testid="member-actions">
      {msg && (
        <p
          role={msg.kind === "err" ? "alert" : undefined}
          data-testid="member-actions-message"
          className={`rounded-[8px] border px-3 py-2 text-[12px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* ---- profile ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Profile
        </p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" data-testid="profile-name" className={INPUT} />
        <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Job title" data-testid="profile-job-title" className={INPUT} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" data-testid="profile-phone" className={INPUT} />
        <input
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="Timezone, e.g. Europe/Budapest"
          data-testid="profile-timezone"
          className={INPUT}
        />
        <input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="Language, e.g. hu" data-testid="profile-locale" className={INPUT} />
        <p className="text-[11px] leading-relaxed text-muted">
          The timezone decides when their start-of-day task email arrives, so it
          is checked rather than trusted.
        </p>
        <button
          onClick={() =>
            run(
              () =>
                updateMemberProfile({
                  userId: user.userId,
                  name,
                  jobTitle: jobTitle || null,
                  phone: phone || null,
                  timezone: timezone || null,
                  locale: locale || null,
                }),
              "Profile saved.",
            )
          }
          disabled={pending || !name.trim()}
          data-testid="profile-save"
          className={`${BTN} w-fit`}
        >
          Save profile
        </button>
      </section>

      {/* ---- email, which is the sign-in identity ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Sign-in address
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted">
          Currently <b>{user.email}</b>. Changing it changes how they sign in, so
          a confirmation link goes to the NEW address and the old one keeps
          working until they click it. Both addresses are told.
        </p>
        <input
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="New address"
          type="email"
          data-testid="email-change-new"
          className={INPUT}
        />
        <button
          onClick={() =>
            run(
              () => requestMemberEmailChange({ userId: user.userId, newEmail }),
              `Confirmation sent to ${newEmail}. The old address works until they click it.`,
            )
          }
          disabled={pending || !newEmail.trim()}
          data-testid="email-change-send"
          className={`${BTN} w-fit`}
        >
          Send the confirmation
        </button>
      </section>

      {/* ---- 2FA reset, reason mandatory ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Two-factor authentication
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted">
          Resetting this is the classic social-engineering target — “hi, it&apos;s
          Anna, I lost my phone”. Write down who asked and how you know it was
          them. It goes on the record with your name on it, and they are emailed.
        </p>
        <input
          value={totpReason}
          onChange={(e) => setTotpReason(e.target.value)}
          placeholder="Who asked, and how you verified them"
          data-testid="totp-reset-reason"
          className={INPUT}
        />
        <button
          onClick={() =>
            run(
              () => resetMemberTotp({ userId: user.userId, reason: totpReason }),
              "Reset. They must register a new authenticator, and have been emailed.",
            )
          }
          disabled={pending || totpReason.trim().length < 10}
          data-testid="totp-reset"
          className={`${BTN} w-fit`}
        >
          Reset their authenticator
        </button>
      </section>

      {/* ---- role, with the computed preview ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Role
        </p>
        <select
          value={previewRole}
          onChange={(e) => {
            const role = e.target.value;
            setPreviewRole(role);
            setRolePreview(null);
            if (!role) return;
            startTransition(async () => {
              const res = await previewRoleChange({ userId: user.userId, role });
              if (res.ok) setRolePreview(res);
              else setMsg({ kind: "err", text: res.error });
            });
          }}
          data-testid="role-preview-select"
          className={INPUT}
        >
          <option value="">What would change if they became…</option>
          {["OWNER", "ADMIN", "BDR", "CLIENT"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {rolePreview && (
          <div data-testid="role-preview" className="grid gap-1 text-[11.5px]">
            {rolePreview.identical && (
              <span className="text-muted">Nothing would change.</span>
            )}
            {rolePreview.gains.map((g) => (
              <span key={g} className="text-[#8CEFC0]">
                + {g}
              </span>
            ))}
            {rolePreview.loses.map((g) => (
              <span key={g} className="text-[#FFB3C2]">
                − {g}
              </span>
            ))}
            <span className="text-[10.5px] text-muted">
              Computed from the grants model, so it cannot drift from what the
              server enforces.
            </span>
          </div>
        )}
      </section>

      {/* ---- suspend / reinstate ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Access
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted">
          Suspending signs them out immediately and takes them out of every
          assignee picker. Everything they own stays theirs and stays attributed
          — and reinstating gives back exactly the role and capabilities they had.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() =>
              run(
                () => setMemberSuspended({ userId: user.userId, suspended: true }),
                "Suspended, and signed out everywhere.",
              )
            }
            disabled={pending || user.isSelf || user.state !== "ACTIVE"}
            data-testid="member-suspend"
            className={BTN}
          >
            Suspend
          </button>
          <button
            onClick={() =>
              run(
                () => setMemberSuspended({ userId: user.userId, suspended: false }),
                "Reinstated with exactly what they had.",
              )
            }
            disabled={pending || user.state !== "SUSPENDED"}
            data-testid="member-reinstate"
            className={BTN}
          >
            Reinstate
          </button>
          <button
            onClick={() => setRemoving(true)}
            disabled={pending || user.isSelf}
            data-testid="member-remove"
            className={`${BTN} border-[#FFB3C2] text-[#FFB3C2]`}
          >
            Remove from workspace…
          </button>
        </div>
      </section>

      {/* ---- ownership ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Transfer ownership to them
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted">
          A workspace has exactly one Owner. This promotes them and demotes you
          to Admin, and is irreversible without their consent — so it asks for
          your password and your six-digit code. A session is not proof enough
          for that; a borrowed laptop is a session.
        </p>
        <select
          value={transferTo}
          onChange={(e) => setTransferTo(e.target.value)}
          data-testid="transfer-to"
          className={INPUT}
        >
          <option value="">Who takes it…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          value={transferPassword}
          onChange={(e) => setTransferPassword(e.target.value)}
          type="password"
          placeholder="Your password"
          data-testid="transfer-password"
          className={INPUT}
        />
        <input
          value={transferCode}
          onChange={(e) => setTransferCode(e.target.value)}
          inputMode="numeric"
          placeholder="Your six-digit code"
          data-testid="transfer-code"
          className={INPUT}
        />
        <input
          value={transferReason}
          onChange={(e) => setTransferReason(e.target.value)}
          placeholder="Why"
          data-testid="transfer-reason"
          className={INPUT}
        />
        <button
          onClick={() =>
            run(
              () =>
                transferOwnership({
                  toUserId: transferTo,
                  password: transferPassword,
                  code: transferCode,
                  reason: transferReason,
                }),
              "Ownership transferred. You are an Admin now.",
            )
          }
          disabled={pending || !transferTo || !transferPassword || !transferReason.trim()}
          data-testid="transfer-submit"
          className={`${BTN} w-fit border-[#FFB3C2] text-[#FFB3C2]`}
        >
          Transfer ownership
        </button>
      </section>

      {/* ---- the account itself ---- */}
      <section className={SECTION}>
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          The account
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted">
          Deleting an account is only possible once they are in no workspace at
          all, and it waits thirty days before anything is erased — deleting a
          person is the one action here with no undo, so it gets one.
        </p>
        <input
          value={deleteReason}
          onChange={(e) => setDeleteReason(e.target.value)}
          placeholder="Why"
          data-testid="delete-reason"
          className={INPUT}
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() =>
              run(
                () => deleteUserAccount({ userId: user.userId, reason: deleteReason }),
                "Scheduled for deletion in 30 days. Restorable until then.",
              )
            }
            disabled={pending || !deleteReason.trim()}
            data-testid="delete-account"
            className={`${BTN} border-[#FFB3C2] text-[#FFB3C2]`}
          >
            Schedule deletion
          </button>
          <button
            onClick={() => run(() => restoreUserAccount(user.userId), "Restored.")}
            disabled={pending}
            data-testid="restore-account"
            className={BTN}
          >
            Restore
          </button>
        </div>
      </section>

      {removing && (
        <MemberRemoveFlow
          user={user}
          candidates={candidates}
          teams={teams}
          onClose={() => setRemoving(false)}
        />
      )}
    </div>
  );
}
