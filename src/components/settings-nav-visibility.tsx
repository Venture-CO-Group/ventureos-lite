"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import { setHiddenNav } from "@/modules/workspaces/actions";
import { HIDEABLE_FEATURES, NAV_FEATURES } from "@/modules/workspaces/nav-visibility";

/**
 * What this workspace shows.
 *
 * ── THE SENTENCE THAT HAS TO BE ON SCREEN ───────────────────────────────────
 *
 * Hiding is decluttering, not permission. An Owner who reads this control as
 * "remove access" would hand somebody a role believing a capability had been
 * taken away, and it would not have been. So the panel says it in plain words
 * rather than leaving it to be discovered.
 */
export function SettingsNavVisibility({
  hidden,
  isOwner,
}: {
  hidden: string[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [set, setSet] = useState<Set<string>>(new Set(hidden));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const essential = NAV_FEATURES.filter((f) => f.essential);

  async function toggle(key: string, hide: boolean) {
    const next = new Set(set);
    if (hide) next.add(key);
    else next.delete(key);
    setSet(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await setHiddenNav([...next]);
      if (!res.ok) {
        setError(res.error);
        setSet(set); // put the switch back where it was
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
      setSet(set);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        What this workspace shows
      </div>
      <p className="mb-1.5 text-[11.5px] leading-relaxed text-muted">
        Switch off the parts you do not use. They leave the sidebar, the phone
        tab bar and the command palette for everybody in this workspace.
      </p>
      <p className="mb-3 rounded-[8px] border border-[rgba(245,184,65,0.3)] bg-[rgba(245,184,65,0.07)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[#F5D9A0]">
        <b>This tidies the menu; it does not restrict access.</b> The pages stay
        reachable by their address, and everything they do keeps the same role
        and capability checks. To stop somebody doing something, take the
        capability away in <i>users &amp; grants</i> instead.
      </p>

      {!isOwner && (
        <p className="mb-3 text-[12px] text-muted">
          Read-only — only an Owner can change what this workspace shows.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="mb-3 text-[12px] text-[#3DDC97]" data-testid="nav-visibility-saved">
          Saved.
        </p>
      )}

      <div className="grid gap-1.5 sm:grid-cols-2">
        {HIDEABLE_FEATURES.map((f) => {
          const isHidden = set.has(f.key);
          return (
            <label
              key={f.key}
              data-testid={`nav-toggle-${f.key}`}
              className={`flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 transition-colors ${
                isHidden ? "border-line bg-panel-2/40 opacity-70" : "border-line bg-panel-2"
              }`}
            >
              <input
                type="checkbox"
                checked={!isHidden}
                disabled={!isOwner || busy}
                onChange={(e) => void toggle(f.key, !e.target.checked)}
                style={{ accentColor: "#7427C6" }}
                className="mt-[3px]"
              />
              <span className="min-w-0">
                <b className={`block text-[12.5px] ${isHidden ? "text-muted" : "text-ink"}`}>
                  {f.label}
                </b>
                {f.hint && (
                  <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted">
                    {f.hint}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Always shown: {essential.map((f) => f.label).join(", ")}. Hiding any of
        these would leave somebody with no way back to their own data or their
        own settings.
      </p>
    </div>
  );
}
