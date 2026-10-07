"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GRANTS } from "@/lib/grants";
import { serverActionError } from "@/lib/client/server-action";
import {
  addExistingMember,
  deleteWorkspace,
  getWorkspaceAdmin,
  inviteToWorkspace,
  saveWorkspaceDetails,
} from "@/modules/workspaces/admin-actions";
import type {
  AssignableUser,
  WorkspaceDetails,
  WorkspaceMemberRow,
} from "@/modules/workspaces/admin";

/**
 * Manage one workspace from its row: members, details, deletion.
 *
 * ── WHY ON THE ROW AND NOT AFTER A SWITCH ──────────────────────────────────
 *
 * The old form said "Assign a member (this workspace)" and meant the ACTIVE
 * one, so putting a colleague into a newly created workspace meant switching
 * into it first — which nothing said. Every action here names its workspace,
 * and the server re-checks that the person pressing it owns that workspace.
 */
const INPUT =
  "min-h-[40px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";
const BTN =
  "min-h-[40px] rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[8px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";

type Tab = "members" | "details" | "delete";
type Msg = { kind: "ok" | "err"; text: string } | null;

export function WorkspaceManage({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("members");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [details, setDetails] = useState<WorkspaceDetails | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberRow[]>([]);
  const [assignable, setAssignable] = useState<AssignableUser[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getWorkspaceAdmin(workspaceId);
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setDetails(res.details);
      setMembers(res.members);
      setAssignable(res.assignable);
    } catch (e) {
      setMsg({ kind: "err", text: serverActionError(e) });
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every mutation goes through here: busy flag, caught throw, one message,
   * reload. The success text may depend on the answer, hence the function form.
   */
  async function run<R extends { ok: boolean; error?: string }>(
    work: () => Promise<R>,
    okText: string | ((res: R) => string),
  ): Promise<R | null> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await work();
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error ?? "Something went wrong." });
        return res;
      }
      setMsg({ kind: "ok", text: typeof okText === "function" ? okText(res) : okText });
      await load();
      router.refresh();
      return res;
    } catch (e) {
      setMsg({ kind: "err", text: serverActionError(e) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="workspace-manage"
      className="mt-3 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] p-3"
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(["members", "details", "delete"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setMsg(null);
            }}
            data-testid={`manage-tab-${t}`}
            className={`min-h-[36px] rounded-full px-3 py-1 text-[11.5px] font-semibold ${
              tab === t ? "bg-accent-soft text-[#E4D3FF]" : "text-muted hover:text-ink"
            }`}
          >
            {t === "members" ? "Members" : t === "details" ? "Details" : "Delete"}
          </button>
        ))}
        <button type="button" onClick={onClose} className="ml-auto text-[11.5px] text-muted hover:text-ink">
          Close
        </button>
      </div>

      {msg && (
        <p
          role={msg.kind === "err" ? "alert" : "status"}
          data-testid="manage-message"
          className={`mb-3 rounded-[8px] px-3 py-2 text-[12px] ${
            msg.kind === "err"
              ? "border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
              : "border border-accent-soft bg-accent-soft text-[#E4D3FF]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {loading && !details ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : tab === "members" ? (
        <MembersTab
          workspaceId={workspaceId}
          members={members}
          assignable={assignable}
          busy={busy}
          run={run}
        />
      ) : tab === "details" && details ? (
        <DetailsTab details={details} busy={busy} run={run} />
      ) : tab === "delete" ? (
        <DeleteTab
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          busy={busy}
          onDeleted={() => {
            onClose();
            router.refresh();
          }}
          setMsg={setMsg}
          setBusy={setBusy}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Run = <R extends { ok: boolean; error?: string }>(
  work: () => Promise<R>,
  okText: string | ((res: R) => string),
) => Promise<R | null>;

function GrantPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <details className="text-[12px] text-[#C9CEE3]">
      <summary className="cursor-pointer text-[11.5px] text-muted">
        Capabilities ({value.length})
      </summary>
      <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
        {GRANTS.map((g) => (
          <label key={g} className="flex min-h-[32px] items-center gap-2">
            <input
              type="checkbox"
              checked={value.includes(g)}
              onChange={(e) => onChange(e.target.checked ? [...value, g] : value.filter((x) => x !== g))}
              style={{ accentColor: "#7427C6" }}
            />
            {g}
          </label>
        ))}
      </div>
    </details>
  );
}

function RoleSelect({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT} data-testid={testId}>
      <option value="BDR">BDR</option>
      <option value="ADMIN">Admin</option>
      <option value="OWNER">Owner</option>
    </select>
  );
}

function MembersTab({
  workspaceId,
  members,
  assignable,
  busy,
  run,
}: {
  workspaceId: string;
  members: WorkspaceMemberRow[];
  assignable: AssignableUser[];
  busy: boolean;
  run: Run;
}) {
  const [pick, setPick] = useState("");
  const [pickRole, setPickRole] = useState("BDR");
  const [pickGrants, setPickGrants] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [inviteRole, setInviteRole] = useState("BDR");
  const [inviteGrants, setInviteGrants] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <div>
        <div className={`${LABEL} mb-1.5`}>In this workspace ({members.length})</div>
        <ul className="grid gap-1" data-testid="manage-members">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="text-ink">{m.name}</span>
              <span className="text-muted">{m.email}</span>
              <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                {m.role.toLowerCase()}
              </span>
              {m.state !== "ACTIVE" && (
                <span className="rounded-full bg-[rgba(245,184,65,0.15)] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-warn">
                  {m.state.toLowerCase()}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] text-muted">
          Roles, suspension and removal are on the Members page once you switch into this workspace.
        </p>
      </div>

      <div className="grid gap-2 rounded-[9px] border border-line bg-panel-2 p-3">
        <div className={LABEL}>Add someone you already work with</div>
        {assignable.length === 0 ? (
          <p className="text-[11.5px] text-muted">
            Everybody from your other workspaces is already here. Invite a new person below.
          </p>
        ) : (
          <>
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className={INPUT}
              data-testid="assign-existing-user"
            >
              <option value="">Choose a person…</option>
              {assignable.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name} — {u.email}
                </option>
              ))}
            </select>
            <RoleSelect value={pickRole} onChange={setPickRole} testId="assign-existing-role" />
            {pickRole !== "OWNER" && <GrantPicker value={pickGrants} onChange={setPickGrants} />}
            <button
              type="button"
              disabled={busy || !pick}
              data-testid="assign-existing-submit"
              className={`${BTN_PRIMARY} w-fit`}
              onClick={async () => {
                const who = assignable.find((u) => u.userId === pick);
                const res = await run(
                  () =>
                    addExistingMember({ workspaceId, userId: pick, role: pickRole, grants: pickGrants }),
                  `${who?.name ?? "They"} can now switch into this workspace.`,
                );
                if (res?.ok) {
                  setPick("");
                  setPickGrants([]);
                }
              }}
            >
              Add to workspace
            </button>
            <p className="text-[11px] leading-relaxed text-muted">
              They keep their login and get access straight away. Only people from
              workspaces you own are listed.
            </p>
          </>
        )}
      </div>

      <div className="grid gap-2 rounded-[9px] border border-line bg-panel-2 p-3">
        <div className={LABEL}>Invite by email</div>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email *"
          type="email"
          className={INPUT}
          data-testid="ws-invite-email"
        />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={INPUT} />
        <RoleSelect value={inviteRole} onChange={setInviteRole} testId="ws-invite-role" />
        {inviteRole !== "OWNER" && <GrantPicker value={inviteGrants} onChange={setInviteGrants} />}
        <button
          type="button"
          disabled={busy || !email.trim()}
          data-testid="ws-invite-submit"
          className={`${BTN} w-fit`}
          onClick={async () => {
            setLink(null);
            const res = await run(
              async () => {
                const r = await inviteToWorkspace({
                  workspaceId,
                  email,
                  name: name || undefined,
                  role: inviteRole,
                  grants: inviteGrants,
                });
                // The link stays on screen either way: an invitation whose
                // email failed is still a working invitation.
                if (r.ok) setLink(r.url);
                return r.ok && r.emailError
                  ? {
                      ok: false as const,
                      error: `The invitation was created, but the email did not go out (${r.emailError}). Send them the link below.`,
                    }
                  : r;
              },
              (r) =>
                "existingAccount" in r && r.existingAccount
                  ? `Invitation sent. ${email} already has an account: they sign in and press Join.`
                  : `Invitation sent to ${email}. They set a password and an authenticator, then they are in.`,
            );
            if (res?.ok) {
              setEmail("");
              setName("");
              setInviteGrants([]);
            }
          }}
        >
          Send invitation
        </button>
        {link && (
          <code data-testid="ws-invite-link" className="block break-all text-[11px] text-ink">
            {link}
          </code>
        )}
      </div>
    </div>
  );
}

function DetailsTab({ details, busy, run }: { details: WorkspaceDetails; busy: boolean; run: Run }) {
  const [d, setD] = useState({
    name: details.name,
    legalName: details.legalName,
    brandColor: details.brandColor || "#7427C6",
    logoUrl: details.logoUrl,
    mailgunDomain: details.mailgunDomain,
    claudeBudget: String(details.claudeBudget),
    retentionDays: String(details.retentionDays),
  });
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setD((cur) => ({ ...cur, [k]: e.target.value }));

  return (
    <div className="grid gap-2">
      <label className="grid gap-1">
        <span className={LABEL}>Name *</span>
        <input value={d.name} onChange={set("name")} className={INPUT} data-testid="ws-edit-name" />
      </label>
      <label className="grid gap-1">
        <span className={LABEL}>Legal name</span>
        <input value={d.legalName} onChange={set("legalName")} className={INPUT} data-testid="ws-edit-legal" />
      </label>
      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Brand
          <input
            type="color"
            value={d.brandColor}
            onChange={set("brandColor")}
            className="h-9 w-11 rounded border border-line bg-transparent"
          />
        </label>
        <input value={d.logoUrl} onChange={set("logoUrl")} placeholder="Logo URL (https://…)" className={`${INPUT} min-w-[200px] flex-1`} />
      </div>
      <input
        value={d.mailgunDomain}
        onChange={set("mailgunDomain")}
        placeholder="Mailgun domain"
        className={INPUT}
        data-testid="ws-edit-mailgun"
      />
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-1 items-center justify-between gap-2 text-[12px] text-muted">
          Claude $/day
          <input value={d.claudeBudget} onChange={set("claudeBudget")} inputMode="decimal" className={`${INPUT} w-20 text-right`} data-testid="ws-edit-budget" />
        </label>
        <label className="flex flex-1 items-center justify-between gap-2 text-[12px] text-muted">
          Retention (days)
          <input value={d.retentionDays} onChange={set("retentionDays")} inputMode="numeric" className={`${INPUT} w-20 text-right`} data-testid="ws-edit-retention" />
        </label>
      </div>
      <p className="text-[11px] text-muted">
        Letterhead, fonts and an uploaded logo are under Settings → Workspace → Brand.
      </p>
      <button
        type="button"
        disabled={busy || !d.name.trim()}
        data-testid="ws-edit-save"
        className={`${BTN_PRIMARY} w-fit`}
        onClick={() =>
          run(
            () =>
              saveWorkspaceDetails({
                workspaceId: details.id,
                ...d,
                claudeBudget: Number(d.claudeBudget),
                retentionDays: Number(d.retentionDays),
              }),
            "Saved.",
          )
        }
      >
        Save changes
      </button>
    </div>
  );
}

function DeleteTab({
  workspaceId,
  workspaceName,
  busy,
  onDeleted,
  setMsg,
  setBusy,
}: {
  workspaceId: string;
  workspaceName: string;
  busy: boolean;
  onDeleted: () => void;
  setMsg: (m: Msg) => void;
  setBusy: (b: boolean) => void;
}) {
  const [confirm, setConfirm] = useState("");
  return (
    <div className="grid gap-2 rounded-[9px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.06)] p-3">
      <p className="text-[12px] leading-relaxed text-[#FFB3C2]">
        Deleting <b>{workspaceName}</b> removes it from everybody&apos;s switcher at once
        and stops every scheduled job for it. Its leads, documents, files and logs are
        erased for good after 30 days; until then an Owner can restore it from this page.
      </p>
      <label className="grid gap-1">
        <span className={LABEL}>Type the name to confirm</span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={workspaceName}
          className={INPUT}
          data-testid="ws-delete-confirm"
        />
      </label>
      <button
        type="button"
        disabled={busy || confirm.trim() !== workspaceName.trim()}
        data-testid="ws-delete-submit"
        className="min-h-[40px] w-fit rounded-[8px] border border-[rgba(255,92,122,0.6)] bg-[rgba(255,92,122,0.12)] px-3 py-1.5 text-[12px] font-semibold text-[#FFB3C2] disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const res = await deleteWorkspace({ workspaceId, confirmName: confirm });
            if (!res.ok) {
              setMsg({ kind: "err", text: res.error });
              return;
            }
            onDeleted();
          } catch (e) {
            setMsg({ kind: "err", text: serverActionError(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        Delete workspace
      </button>
    </div>
  );
}
