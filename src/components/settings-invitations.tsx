"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  bulkInviteMembers,
  inviteMember,
  resendMemberInvitation,
  revokeMemberInvitation,
  type BulkInviteReport,
} from "@/modules/members/actions";
import { MAX_BULK_INVITES } from "@/modules/members/invitation-logic";
import type { PendingInvitation } from "@/modules/members/invitation-store";
import { GRANTS } from "@/lib/grants";

/**
 * Pending invitations, and the two ways to send one (§2).
 *
 * ── WHY THE LIST IS THE MAIN THING HERE ─────────────────────────────────────
 *
 * Before this, an invitation was a link the Owner had to keep somewhere: once
 * the dialog closed there was no record that anybody had been invited, no way
 * to see who had not accepted, and no way to withdraw one. Six weeks later
 * nobody could say whether a person had been invited or simply forgotten.
 *
 * So the state is on screen — pending, expired, revoked — with the resend
 * count next to it, because five invitations to one address that nobody has
 * accepted is a conversation to have rather than a button to keep pressing.
 */
const BTN =
  "min-h-[32px] rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";

const STATE_STYLE: Record<string, string> = {
  pending: "border-[rgba(245,184,65,0.35)] text-[#FFD79A]",
  expired: "border-line text-muted",
  revoked: "border-line text-muted",
  accepted: "border-[rgba(61,220,151,0.35)] text-[#8CEFC0]",
};

function when(iso: string): string {
  return new Date(iso).toLocaleDateString("hu-HU");
}

export function SettingsInvitations({
  invitations,
  clientCompanies,
}: {
  invitations: PendingInvitation[];
  clientCompanies: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [report, setReport] = useState<BulkInviteReport | null>(null);
  const [mode, setMode] = useState<"one" | "bulk">("one");

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("BDR");
  const [clientCompanyId, setClientCompanyId] = useState("");
  const [grants, setGrants] = useState<string[]>([]);
  const [bulkText, setBulkText] = useState("");

  function send() {
    startTransition(async () => {
      setMsg(null);
      setLink(null);
      setReport(null);
      try {
        const res = await inviteMember({
          email,
          name: name || undefined,
          role,
          grants,
          ...(role === "CLIENT" ? { clientCompanyId } : {}),
        });
        if (!res.ok) {
          setMsg({ kind: "err", text: res.error });
          return;
        }
        setMsg({
          kind: "ok",
          text: res.existingAccount
            ? `Invitation sent. ${email} already has an account here, so they will sign in rather than choose a new password.`
            : `Invitation sent to ${email}.`,
        });
        // Kept on screen as well as emailed: an invitation that silently fails
        // to arrive is worse than one the Owner can paste.
        setLink(res.url);
        setEmail("");
        setName("");
        router.refresh();
      } catch (e) {
        setMsg({ kind: "err", text: serverActionError(e) });
      }
    });
  }

  function sendBulk() {
    startTransition(async () => {
      setMsg(null);
      setLink(null);
      setReport(null);
      try {
        const res = await bulkInviteMembers({ text: bulkText, role, grants });
        if (!res.ok) {
          setMsg({ kind: "err", text: res.error });
          return;
        }
        setReport(res.report);
        setMsg({
          kind: res.report.sent > 0 ? "ok" : "err",
          text: `${res.report.sent} sent, ${res.report.skipped} skipped.`,
        });
        if (res.report.sent > 0) setBulkText("");
        router.refresh();
      } catch (e) {
        setMsg({ kind: "err", text: serverActionError(e) });
      }
    });
  }

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    startTransition(async () => {
      setMsg(null);
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
    <section
      data-testid="settings-invitations"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">invitations</h2>
        <div className="flex rounded-[10px] border border-line bg-panel p-0.5">
          {(["one", "bulk"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              data-testid={`invite-mode-${m}`}
              className={`rounded-[8px] px-2.5 py-1 text-[11.5px] ${
                mode === m ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {m === "one" ? "One person" : "Paste a list"}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        They set their own password and register an authenticator before their
        first sign-in. Nobody else ever sees the password — not even an Owner.
      </p>

      {msg && (
        <p
          role={msg.kind === "err" ? "alert" : undefined}
          data-testid="invitations-message"
          className={`mb-3 rounded-[8px] border px-3 py-2 text-[12px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {link && (
        <div className="mb-3 rounded-[10px] border border-accent bg-accent-soft px-3 py-2.5">
          <b className="block text-[11.5px] text-[#E4D3FF]">
            The link, in case the email does not arrive
          </b>
          <code data-testid="invite-link" className="mt-1 block break-all text-[11px] text-ink">
            {link}
          </code>
        </div>
      )}

      {/* ---- the form ---- */}
      <div className="mb-4 grid gap-2 rounded-[10px] border border-line bg-panel-2 p-3">
        {mode === "one" ? (
          <>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email *"
              type="email"
              data-testid="invite-email-input"
              className={INPUT}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              data-testid="invite-name-input"
              className={INPUT}
            />
          </>
        ) : (
          <>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={5}
              placeholder={"anna@example.hu\nbela@example.hu\ncecil@example.hu"}
              data-testid="invite-bulk-text"
              className={`${INPUT} resize-y font-mono text-[11.5px]`}
            />
            <p className="text-[11px] leading-relaxed text-muted">
              One per line, or separated by commas, semicolons or tabs — paste a
              spreadsheet column straight in. Up to {MAX_BULK_INVITES} at a
              time, all with the role below. Every row is reported back, sent or
              skipped.
            </p>
          </>
        )}

        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          data-testid="invite-role-select"
          className={INPUT}
        >
          <option value="BDR">BDR — the whole daily job, minus documents</option>
          <option value="ADMIN">Admin — everything except user management</option>
          <option value="OWNER">Owner — everything, including users and billing</option>
          {mode === "one" && (
            <option value="CLIENT">Client — read-only, one company&apos;s delivery</option>
          )}
        </select>

        {role === "CLIENT" && mode === "one" && (
          <select
            value={clientCompanyId}
            onChange={(e) => setClientCompanyId(e.target.value)}
            data-testid="invite-client-company-select"
            className={INPUT}
          >
            <option value="">Which company may they see? *</option>
            {clientCompanies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        {role !== "CLIENT" && role !== "OWNER" && (
          <details className="rounded-[8px] border border-line px-2.5 py-1.5">
            <summary className="cursor-pointer text-[11.5px] text-muted">
              Capabilities to hand over on day one ({grants.length} selected)
            </summary>
            <div className="mt-2 grid gap-1">
              {GRANTS.map((g) => (
                <label key={g} className="flex items-center gap-2 text-[11.5px] text-[#C9CEE3]">
                  <input
                    type="checkbox"
                    checked={grants.includes(g)}
                    onChange={(e) =>
                      setGrants((cur) =>
                        e.target.checked ? [...cur, g] : cur.filter((x) => x !== g),
                      )
                    }
                    data-testid={`invite-grant-${g}`}
                    style={{ accentColor: "#7427C6" }}
                  />
                  <code>{g}</code>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              A BDR already carries everything except the five document and
              template capabilities. Leave this empty unless they need those.
            </p>
          </details>
        )}

        <button
          onClick={() => (mode === "one" ? send() : sendBulk())}
          disabled={
            pending ||
            (mode === "one"
              ? !email.trim() || (role === "CLIENT" && !clientCompanyId)
              : !bulkText.trim())
          }
          data-testid="invite-send"
          className="w-fit rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {pending ? "Sending…" : mode === "one" ? "Send invitation" : "Send them all"}
        </button>
      </div>

      {/* ---- the per-row report, which is the point of bulk ---- */}
      {report && (
        <div
          data-testid="bulk-report"
          className="mb-4 overflow-hidden rounded-[10px] border border-line"
        >
          {report.rows.map((r, i) => (
            <div
              key={`${r.raw}-${i}`}
              data-testid="bulk-report-row"
              className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-1.5 text-[11.5px] last:border-0"
            >
              <span className={r.sent ? "text-[#8CEFC0]" : "text-muted"}>
                {r.sent ? "sent" : "skipped"}
              </span>
              <code className="text-ink">{r.email ?? r.raw}</code>
              {r.problem && <span className="text-muted">— {r.problem}</span>}
            </div>
          ))}
        </div>
      )}

      {/* ---- what is outstanding ---- */}
      {invitations.length === 0 ? (
        <p className="text-[12.5px] text-muted">Nothing outstanding.</p>
      ) : (
        <ul className="grid gap-1.5">
          {invitations.map((inv) => (
            <li
              key={inv.id}
              data-testid="invitation-row"
              className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-panel-2 px-3 py-2"
            >
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  STATE_STYLE[inv.state] ?? "border-line text-muted"
                }`}
                data-testid={`invitation-state-${inv.id}`}
              >
                {inv.state}
              </span>
              <code className="min-w-0 flex-1 break-all text-[12px] text-ink">{inv.email}</code>
              <span className="text-[11px] text-muted">{inv.role}</span>
              <span className="text-[11px] tabular-nums text-muted">
                expires {when(inv.expiresAt)}
              </span>
              {inv.resendCount > 0 && (
                <span className="text-[11px] text-muted">sent {inv.resendCount + 1}×</span>
              )}
              {inv.stale && inv.state === "pending" && (
                // The list an auditor asks for (§7): an invitation older than
                // its own window that nobody has acted on.
                <span className="text-[11px] text-warn">older than the window</span>
              )}
              {inv.state !== "accepted" && (
                <button
                  onClick={() =>
                    act(() => resendMemberInvitation(inv.id), `Sent again to ${inv.email}.`)
                  }
                  disabled={pending || inv.state === "revoked"}
                  data-testid={`invitation-resend-${inv.id}`}
                  className={BTN}
                >
                  Resend
                </button>
              )}
              {inv.state === "pending" && (
                <button
                  onClick={() =>
                    act(() => revokeMemberInvitation(inv.id), `Withdrawn: ${inv.email}.`)
                  }
                  disabled={pending}
                  data-testid={`invitation-revoke-${inv.id}`}
                  className={`${BTN} hover:border-[#FFB3C2]`}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
