"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createPasswordResetLink,
  inviteUser,
  removeMember,
  resetUserTotp,
  revokeUserSessions,
  setUserPassword,
  setUserRole,
  setUserSuspended,
  unlockUser,
  updateUserIdentity,
} from "@/modules/users/actions";
import type { ManagedUser } from "@/modules/users/actions";
import type { UserStatus } from "@/modules/users/status";
import { Modal } from "./modal";

/**
 * Users (P8/2).
 *
 * ── WHAT WAS WRONG WITH THE OLD ONE ─────────────────────────────────────────
 *
 * It could set a password, issue a reset link, reset 2FA, unlock an account and
 * sign every session out — a good set of levers, badly presented, with three
 * holes in it.
 *
 *   - It could not ADD anybody. Inviting lived in a different panel behind a
 *     bare email field, and it created the account with an unusable password
 *     for the Owner to set and then tell them — a password travelling through a
 *     chat window, known to two people and never changed.
 *   - It could not change a ROLE, and it could not REMOVE or STAND DOWN a
 *     member at all. The only way to stop somebody reaching a workspace was to
 *     delete their membership by hand in the database.
 *   - It rendered four independent chips — "no password", "must change", "2FA
 *     off", "locked" — and left the reader to work out what they added up to.
 *     They add up to one thing, which is the only question being asked: can
 *     this person get in right now, and if not, why not.
 */

const CARD = "rounded-[14px] border border-line bg-[rgba(239,241,248,0.04)] p-4 sm:p-5";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_DANGER =
  "min-h-[36px] rounded-[8px] border border-[rgba(255,92,122,0.35)] px-2.5 py-1.5 text-[11.5px] font-semibold text-[#FFB3C2] transition-colors hover:border-[#FF5C7A] disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45";
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

type Msg = { kind: "ok" | "err"; text: string } | null;

const STATUS_STYLE: Record<UserStatus, string> = {
  active: "bg-[rgba(61,220,151,0.15)] text-[#8CEFC0]",
  invited: "bg-accent-soft text-accent-ink",
  suspended: "bg-[rgba(245,184,65,0.15)] text-[#FFD79A]",
  locked: "bg-[rgba(255,92,122,0.15)] text-[#FFB3C2]",
};

const STATUS_LABEL: Record<UserStatus, string> = {
  active: "Active",
  invited: "Invited",
  suspended: "Suspended",
  locked: "Locked",
};

/** What the status actually means, so nobody has to infer it. */
const STATUS_HINT: Record<UserStatus, string> = {
  active: "Can sign in.",
  invited: "Has never signed in — send them their link.",
  suspended: "Access to this workspace is paused. They are signed out.",
  locked: "Too many failed sign-ins. Unlock to let them try again.",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("hu-HU");
}

export function SettingsUsers({
  users,
  minPasswordLength,
}: {
  users: ManagedUser[];
  minPasswordLength: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [inviting, setInviting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | UserStatus>("all");
  const [link, setLink] = useState<{
    user: string;
    url: string;
    expiresAt: string;
    kind: "reset" | "invite";
  } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      setMsg(res.ok ? { kind: "ok", text: okText } : { kind: "err", text: res.error ?? "Failed." });
      router.refresh();
    });
  }

  function confirmThen(question: string, fn: () => void) {
    // A browser confirm is the right weight: these are destructive, Owner-only
    // actions that sign somebody out.
    if (window.confirm(question)) fn();
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q)
      );
    });
  }, [users, query, statusFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: users.length };
    for (const u of users) c[u.status] = (c[u.status] ?? 0) + 1;
    return c;
  }, [users]);

  return (
    <div className={CARD} id="users">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-2xl font-bold lowercase tracking-display">users</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Owner-only. Every change here is written to the audit log, and
            anything that changes how somebody signs in also signs them out.
          </p>
        </div>
        <button
          type="button"
          className={BTN_PRIMARY}
          data-testid="invite-user"
          onClick={() => setInviting(true)}
        >
          + Invite somebody
        </button>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="users-message"
          className={`mb-4 rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* ---- filter bar. Appears once there is enough to filter. ---------- */}
      {users.length > 4 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email or role"
            data-testid="user-search"
            className="min-w-[200px] flex-1 rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
          />
          {(["all", "active", "invited", "suspended", "locked"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-[8px] border px-2.5 py-1.5 text-[11.5px] capitalize ${
                statusFilter === s
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {s} {counts[s] ? <span className="tabular-nums">{counts[s]}</span> : null}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
              <th className="px-2 py-1.5 font-semibold">User</th>
              <th className="px-2 py-1.5 font-semibold">Role</th>
              <th className="px-2 py-1.5 font-semibold">Status</th>
              <th className="px-2 py-1.5 font-semibold">Last sign-in</th>
              <th className="px-2 py-1.5 font-semibold">Devices</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody data-testid="users-table">
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted">
                  Nobody matches that.
                </td>
              </tr>
            )}
            {shown.map((u) => (
              <>
                <tr key={u.userId} className="border-b border-line last:border-0">
                  <td className="px-2 py-2.5">
                    <span className="block text-ink">
                      {u.name}
                      {u.isSelf && <span className="ml-1.5 text-[11px] text-muted">(you)</span>}
                    </span>
                    <span className="block text-[11.5px] text-muted">{u.email}</span>
                  </td>

                  <td className="px-2 py-2.5">
                    {/*
                      Editable in place. Changing somebody's role was previously
                      only possible by re-running the "assign a member" form in
                      a different panel with the right email spelled again.
                    */}
                    <select
                      value={u.role}
                      disabled={pending || u.isSelf || u.isLastOwner}
                      title={
                        u.isSelf
                          ? "You cannot change your own role."
                          : u.isLastOwner
                            ? "The last Owner's role cannot change — promote somebody else first."
                            : undefined
                      }
                      data-testid={`user-role-${u.userId}`}
                      onChange={(e) =>
                        run(
                          () => setUserRole({ userId: u.userId, role: e.target.value }),
                          `${u.email} is now ${e.target.value}.`,
                        )
                      }
                      className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-1.5 py-1 text-[11.5px] text-ink outline-none focus:border-accent disabled:opacity-50"
                    >
                      <option value="OWNER">Owner</option>
                      <option value="ADMIN">Admin</option>
                      <option value="BDR">BDR</option>
                    </select>
                  </td>

                  <td className="px-2 py-2.5">
                    <span
                      title={STATUS_HINT[u.status]}
                      data-testid={`user-status-${u.userId}`}
                      className={`rounded-[5px] px-1.5 py-px text-[10px] font-semibold ${STATUS_STYLE[u.status]}`}
                    >
                      {STATUS_LABEL[u.status]}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {u.totpEnabled ? (
                        <span className="rounded-[5px] bg-panel-2 px-1.5 py-px text-[10px] text-[#8CEFC0]">
                          2FA
                        </span>
                      ) : u.mustEnrollTotp ? (
                        <span className="rounded-[5px] bg-[rgba(245,184,65,0.15)] px-1.5 py-px text-[10px] text-[#FFD79A]">
                          must enroll 2FA
                        </span>
                      ) : null}
                      {u.mustChangePassword && u.hasPassword && (
                        <span className="rounded-[5px] bg-panel-2 px-1.5 py-px text-[10px] text-muted">
                          must change
                        </span>
                      )}
                    </span>
                  </td>

                  <td className="px-2 py-2.5 text-muted">{ago(u.lastLoginAt)}</td>

                  <td className="px-2 py-2.5">
                    <button
                      type="button"
                      disabled={u.activeSessions === 0}
                      onClick={() => setExpanded(expanded === u.userId ? null : u.userId)}
                      data-testid={`user-sessions-${u.userId}`}
                      className="tabular-nums text-muted underline decoration-dotted hover:text-ink disabled:no-underline"
                    >
                      {u.activeSessions}
                    </button>
                  </td>

                  <td className="px-2 py-2.5">
                    <span className="flex flex-wrap justify-end gap-1.5">
                      <button
                        type="button"
                        className={BTN}
                        data-testid={`user-edit-${u.userId}`}
                        onClick={() => setEditing(u)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={BTN}
                        disabled={pending}
                        data-testid={`user-reset-link-${u.userId}`}
                        onClick={() =>
                          startTransition(async () => {
                            setMsg(null);
                            const res = await createPasswordResetLink({ userId: u.userId });
                            if (!res.ok) {
                              setMsg({ kind: "err", text: res.error });
                              return;
                            }
                            setLink({
                              user: u.email,
                              url: res.url,
                              expiresAt: res.expiresAt,
                              kind: "reset",
                            });
                            router.refresh();
                          })
                        }
                      >
                        {u.status === "invited" ? "Invite link" : "Reset link"}
                      </button>
                      {(u.totpEnabled || u.mustEnrollTotp) && (
                        <button
                          type="button"
                          className={BTN}
                          disabled={pending}
                          data-testid={`user-reset-2fa-${u.userId}`}
                          onClick={() =>
                            confirmThen(
                              `Reset two-factor for ${u.email}? Their current authenticator stops working and they must scan a new QR at next sign-in.`,
                              () =>
                                run(
                                  () => resetUserTotp({ userId: u.userId }),
                                  `Two-factor reset for ${u.email}. They must enroll again.`,
                                ),
                            )
                          }
                        >
                          Reset 2FA
                        </button>
                      )}
                      {u.status === "locked" && (
                        <button
                          type="button"
                          className={BTN}
                          disabled={pending}
                          data-testid={`user-unlock-${u.userId}`}
                          onClick={() =>
                            run(() => unlockUser({ userId: u.userId }), "Account unlocked.")
                          }
                        >
                          Unlock
                        </button>
                      )}
                      {u.activeSessions > 0 && (
                        <button
                          type="button"
                          className={BTN}
                          disabled={pending}
                          onClick={() =>
                            confirmThen(`Sign ${u.email} out of all devices?`, () =>
                              run(
                                () => revokeUserSessions({ userId: u.userId }),
                                `Signed ${u.email} out everywhere.`,
                              ),
                            )
                          }
                        >
                          Sign out
                        </button>
                      )}

                      {!u.isSelf && !u.isLastOwner && (
                        <>
                          <button
                            type="button"
                            className={u.status === "suspended" ? BTN : BTN_DANGER}
                            disabled={pending}
                            data-testid={`user-suspend-${u.userId}`}
                            onClick={() =>
                              u.status === "suspended"
                                ? run(
                                    () =>
                                      setUserSuspended({ userId: u.userId, suspended: false }),
                                    `${u.email} can sign in again.`,
                                  )
                                : confirmThen(
                                    `Suspend ${u.email}? They are signed out immediately and cannot reach this workspace until you restore them. Nothing they wrote is removed.`,
                                    () =>
                                      run(
                                        () =>
                                          setUserSuspended({ userId: u.userId, suspended: true }),
                                        `${u.email} is suspended and signed out.`,
                                      ),
                                  )
                            }
                          >
                            {u.status === "suspended" ? "Restore" : "Suspend"}
                          </button>
                          <button
                            type="button"
                            className={BTN_DANGER}
                            disabled={pending}
                            data-testid={`user-remove-${u.userId}`}
                            onClick={() =>
                              confirmThen(
                                `Remove ${u.email} from this workspace? Their account and everything they wrote stay — they simply lose access here. Suspend instead if they might come back.`,
                                () =>
                                  run(
                                    () => removeMember({ userId: u.userId }),
                                    `${u.email} was removed from this workspace.`,
                                  ),
                              )
                            }
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>

                {/* ---- session detail --------------------------------- */}
                {expanded === u.userId && u.sessions.length > 0 && (
                  <tr key={`${u.userId}-sessions`} className="border-b border-line">
                    <td colSpan={6} className="px-2 pb-3">
                      <div className="rounded-[10px] border border-line bg-panel-2/40 p-3">
                        <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
                          Signed in on
                        </p>
                        {u.sessions.map((s) => (
                          <div
                            key={s.id}
                            data-testid="session-row"
                            className="flex flex-wrap items-baseline gap-2 py-1 text-[11.5px] text-[#C9CEE3]"
                          >
                            <b>{s.device}</b>
                            {s.ip && <span className="text-muted">{s.ip}</span>}
                            <span className="text-muted">last seen {ago(s.lastSeenAt)}</span>
                            <span className="text-muted">· since {ago(s.createdAt)}</span>
                            {s.isCurrent && (
                              <span className="rounded-[5px] bg-accent-soft px-1.5 py-px text-[10px] text-accent-ink">
                                this device
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditUser
          user={editing}
          minPasswordLength={minPasswordLength}
          pending={pending}
          onClose={() => setEditing(null)}
          onRun={(fn, text) => {
            run(fn, text);
            setEditing(null);
          }}
        />
      )}

      {inviting && (
        <InviteUser
          pending={pending}
          onClose={() => setInviting(false)}
          onInvite={(payload) =>
            startTransition(async () => {
              setMsg(null);
              const res = await inviteUser(payload);
              if (!res.ok) {
                setMsg({ kind: "err", text: res.error });
                return;
              }
              setInviting(false);
              setLink({
                user: payload.email,
                url: res.url,
                expiresAt: res.expiresAt,
                kind: "invite",
              });
              setMsg({
                kind: "ok",
                text: res.existing
                  ? `${payload.email} already had an account and has been added to this workspace.`
                  : `${payload.email} was invited.`,
              });
              router.refresh();
            })
          }
        />
      )}

      {link && (
        <Modal onClose={() => setLink(null)} labelledBy="reset-link-title">
          <h3 id="reset-link-title" className="mb-2 font-display text-lg font-bold lowercase">
            {link.kind === "invite" ? "invite link for" : "reset link for"} {link.user}
          </h3>
          <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
            Single use, valid until {link.expiresAt.slice(0, 16).replace("T", " ")}.
            They choose their own password — nobody else ever knows it. Send it
            over a channel you trust: anyone holding this link can set that
            password.
          </p>
          <code
            data-testid="reset-link-url"
            className="block break-all rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] p-2.5 text-[11.5px] text-ink"
          >
            {link.url}
          </code>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className={BTN}
              onClick={() => navigator.clipboard.writeText(link.url).catch(() => {})}
            >
              Copy
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={() => setLink(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------

function InviteUser({
  pending,
  onClose,
  onInvite,
}: {
  pending: boolean;
  onClose: () => void;
  onInvite: (input: { email: string; name: string; role: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("BDR");

  return (
    <Modal onClose={onClose} labelledBy="invite-title">
      <div className="mb-3 flex items-center">
        <h3 id="invite-title" className="font-display text-lg font-bold lowercase">
          invite somebody
        </h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="grid gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          data-testid="invite-name"
          className={INPUT}
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          type="email"
          data-testid="invite-email"
          className={INPUT}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          data-testid="invite-role"
          className={INPUT}
        >
          <option value="BDR">BDR — the whole daily job, minus documents</option>
          <option value="ADMIN">Admin — everything except user management</option>
          <option value="OWNER">Owner — everything, including users and billing</option>
        </select>
        <p className="text-[11.5px] leading-relaxed text-muted">
          You will get a one-hour link to send them. They set their own password
          from it, so no password is ever typed into a chat window. If they
          already have an account here, they are simply added to this workspace.
        </p>
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending || !email.trim() || !name.trim()}
          data-testid="invite-submit"
          onClick={() => onInvite({ email: email.trim(), name: name.trim(), role })}
        >
          Invite
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

function EditUser({
  user,
  minPasswordLength,
  pending,
  onClose,
  onRun,
}: {
  user: ManagedUser;
  minPasswordLength: number;
  pending: boolean;
  onClose: () => void;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const [requireChange, setRequireChange] = useState(true);

  return (
    <Modal onClose={onClose} labelledBy="edit-user-title">
      <div className="mb-3 flex items-center">
        <h3 id="edit-user-title" className="font-display text-lg font-bold lowercase">
          edit {user.email}
        </h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      <p className="mb-3 text-[11.5px] text-muted">
        Joined {ago(user.joinedAt)} · last sign-in {ago(user.lastLoginAt)} ·{" "}
        {user.activeSessions} active {user.activeSessions === 1 ? "device" : "devices"}
      </p>

      <div className="grid gap-3">
        <section className="rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Identity
          </p>
          <div className="grid gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              data-testid="edit-user-name"
              className={INPUT}
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              type="email"
              data-testid="edit-user-email"
              className={INPUT}
            />
            {email !== user.email && (
              <p className="text-[11.5px] text-warn">
                Changing the email changes how they sign in — it will sign them
                out of every device.
              </p>
            )}
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={pending || !name.trim() || !email.trim()}
              data-testid="edit-user-save"
              onClick={() =>
                onRun(
                  () => updateUserIdentity({ userId: user.userId, name, email }),
                  "User updated.",
                )
              }
            >
              Save identity
            </button>
          </div>
        </section>

        <section className="rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Set a password directly
          </p>
          <p className="mb-2 text-[11.5px] leading-relaxed text-muted">
            At least {minPasswordLength} characters. Prefer the reset link unless
            you are handing the password over in person — a password you set is a
            password two people know.
          </p>
          <div className="grid gap-2">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              type="text"
              autoComplete="off"
              data-testid="edit-user-password"
              className={INPUT}
            />
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={requireChange}
                onChange={(e) => setRequireChange(e.target.checked)}
              />
              Make them choose their own at next sign-in
            </label>
            <button
              type="button"
              className={BTN}
              disabled={pending || password.length < minPasswordLength}
              data-testid="edit-user-set-password"
              onClick={() =>
                onRun(
                  () => setUserPassword({ userId: user.userId, password, requireChange }),
                  `Password set for ${user.email}; they are signed out everywhere.`,
                )
              }
            >
              Set password
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
