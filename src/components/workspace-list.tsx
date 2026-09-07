"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  repairWorkspace,
  renameWorkspace,
  switchWorkspace,
  type WorkspaceSummary,
} from "@/modules/workspaces/actions";
import { serverActionError } from "@/lib/client/server-action";

/**
 * The workspaces you belong to, and what is actually in them.
 *
 * ── WHY THE COUNTS ARE ON SCREEN ────────────────────────────────────────────
 *
 * A workspace created through the old "New workspace" form had no deal
 * pipelines, no document templates and no targets, because the form created a
 * row and nothing else. None of that was visible: every screen rendered a
 * normal empty state, so a workspace that could not produce a quote looked
 * exactly like one nobody had used yet. Showing the numbers — and a Repair
 * button beside the ones that are short — makes the difference legible.
 */
function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="min-w-[62px]">
      <div
        className={`font-display text-[17px] font-bold tabular-nums leading-none ${
          bad ? "text-[#FF5C7A]" : "text-ink"
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.1em] text-muted">{label}</div>
    </div>
  );
}

export function WorkspaceList({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  async function repair(id: string) {
    setBusy(id);
    setMsg(null);
    setError(null);
    try {
      const res = await repairWorkspace(id);
      if (res.ok) {
        setMsg(res.added);
        router.refresh();
      } else setError(res.error);
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(null);
    }
  }

  async function rename(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await renameWorkspace(id, draftName);
      if (res.ok) {
        setEditing(null);
        router.refresh();
      } else setError(res.error);
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(null);
    }
  }

  async function activate(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await switchWorkspace(id);
      if (res.ok) router.refresh();
      else setError(res.error);
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Your workspaces
      </div>
      <p className="mb-3 text-[11.5px] text-muted">
        Each workspace is a separate company: its own leads, documents, branding
        and members. Nothing is ever shared between them.
      </p>

      {msg && (
        <p className="mb-3 rounded-[8px] border border-accent-soft bg-accent-soft px-3 py-2 text-[12px] text-[#E4D3FF]">
          {msg}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}

      <div className="grid gap-2.5">
        {workspaces.map((w) => (
          <div
            key={w.id}
            data-testid="workspace-row"
            className={`rounded-[11px] border p-3.5 ${
              w.active ? "border-accent bg-accent-soft/40" : "border-line bg-panel-2"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {editing === w.id ? (
                <>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="min-w-[180px] flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => rename(w.id)}
                    disabled={busy === w.id}
                    className="rounded-[8px] border border-accent bg-accent-soft px-2.5 py-1.5 text-[11.5px] font-semibold text-[#E4D3FF] disabled:opacity-60"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="rounded-[8px] border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <b className="text-[13.5px]">{w.name}</b>
                  {w.active && (
                    <span className="rounded-full bg-[rgba(61,220,151,0.15)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#3DDC97]">
                      active
                    </span>
                  )}
                  <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                    {w.role.toLowerCase()}
                  </span>
                  {w.needsProvisioning && (
                    <span
                      data-testid="needs-provisioning"
                      className="rounded-full bg-[rgba(245,184,65,0.15)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-warn"
                    >
                      incomplete
                    </span>
                  )}
                  <div className="ml-auto flex gap-2">
                    {!w.active && (
                      <button
                        onClick={() => activate(w.id)}
                        disabled={busy === w.id}
                        className="rounded-[8px] border border-line bg-panel px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
                      >
                        Switch to it
                      </button>
                    )}
                    {w.role === "OWNER" && (
                      <button
                        onClick={() => {
                          setEditing(w.id);
                          setDraftName(w.name);
                        }}
                        className="rounded-[8px] border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-muted hover:text-ink"
                      >
                        Rename
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-4">
              <Stat label="members" value={w.members} />
              <Stat label="leads" value={w.leads} />
              <Stat label="pipelines" value={w.pipelines} bad={w.pipelines === 0} />
              <Stat label="templates" value={w.templates} bad={w.templates === 0} />
              <Stat label="targets" value={w.targets} bad={w.targets === 0} />
            </div>

            {w.needsProvisioning && w.role === "OWNER" && (
              <div className="mt-3 rounded-[9px] border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.08)] px-3 py-2.5">
                <p className="text-[11.5px] leading-relaxed text-[#F5D9A0]">
                  This workspace is missing part of its setup, so the Deals board
                  has no columns and no document can be rendered. Repair adds only
                  what is absent — nothing you have already changed is touched.
                </p>
                <button
                  onClick={() => repair(w.id)}
                  disabled={busy === w.id}
                  data-testid="repair-workspace"
                  className="mt-2 rounded-[8px] border border-warn bg-[rgba(245,184,65,0.12)] px-2.5 py-1.5 text-[11.5px] font-semibold text-warn disabled:opacity-60"
                >
                  {busy === w.id ? "Repairing…" : "Repair setup"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
