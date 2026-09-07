"use client";
import { attemptVoid } from "@/lib/client/server-action";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { switchWorkspace, type WorkspaceOption } from "@/modules/workspaces/actions";

export function WorkspaceSwitcher({
  workspaces,
  canManage = false,
  testId = "active-workspace",
}: {
  workspaces: WorkspaceOption[];
  /**
   * Show the way to add one.
   *
   * A switcher with a single entry is indistinguishable from a broken switcher:
   * you open it, there is nothing else in it, and clicking the one row you can
   * see does nothing (correctly — it is already active). The workspace form
   * lives three clicks away in admin settings, so nothing on this menu said
   * that adding a second workspace was even possible.
   */
  canManage?: boolean;
  /**
   * The shell renders one switcher in the sidebar and one in the phone header.
   * Both are always in the DOM (CSS decides which is visible), so they must not
   * share a test id or selectors resolve to two elements.
   */
  testId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = workspaces.find((w) => w.active) ?? workspaces[0];

  async function pick(id: string) {
    if (id === active?.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    /**
     * A switch that fails silently is the worst one in the app: the menu closes,
     * the page refreshes, and you are still in the workspace you were in — while
     * believing you are in another. Everything you then read or write is in the
     * wrong place, as far as you know.
     */
    const failed = await attemptVoid(switchWorkspace(id));
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="relative">
      {error && (
        <p
          role="alert"
          data-testid="workspace-switch-error"
          className="mb-1.5 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-2.5 py-1.5 text-[11.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mb-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-[11px] border border-line bg-panel px-2.5 py-2.5 hover:bg-panel-2 disabled:opacity-60"
      >
        <div className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-grad font-display text-[13px] font-extrabold">
          {(active?.name ?? "V").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 leading-tight">
          <b className="block truncate text-left text-[12.5px]" data-testid={testId}>
            {active?.name ?? "No workspace"}
          </b>
          <span className="block text-[10px] uppercase tracking-[0.08em] text-muted">workspace</span>
        </div>
        <span className="ml-auto text-[11px] text-muted">▾</span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-[52px] z-50 overflow-hidden rounded-[11px] border border-line bg-[rgba(6,11,38,0.98)] backdrop-blur"
        >
          {workspaces.map((w) => (
            <li key={w.id}>
              <button
                onClick={() => pick(w.id)}
                data-testid="workspace-option"
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] hover:bg-panel-2 ${
                  w.active ? "text-ink" : "text-[#C9CEE3]"
                }`}
              >
                <span className="truncate">{w.name}</span>
                <span className="ml-auto text-[10px] uppercase tracking-[0.08em] text-muted">{w.role.toLowerCase()}</span>
                {w.active && <span className="text-[11px] text-[#3DDC97]">✓</span>}
              </button>
            </li>
          ))}
          {canManage && (
            <li className="border-t border-line">
              <Link
                href="/settings/workspaces"
                data-testid="manage-workspaces"
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-ink"
              >
                <span>+ New workspace</span>
                <span className="ml-auto text-[10px] uppercase tracking-[0.08em]">manage</span>
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
