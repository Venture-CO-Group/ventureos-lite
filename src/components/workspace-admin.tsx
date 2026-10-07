"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createWorkspace } from "@/modules/workspaces/actions";
import { COPY_GROUPS } from "@/modules/workspaces/copy-plan";
import { serverActionError } from "@/lib/client/server-action";

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

export function WorkspaceAdmin({
  isOwner,
  copyableWorkspaces = [],
}: {
  isOwner: boolean;
  /** Workspaces this Owner could copy settings out of (P6/6.1). */
  copyableWorkspaces?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create workspace
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [brandColor, setBrandColor] = useState("#7427C6");
  const [logoUrl, setLogoUrl] = useState("");
  const [mailgunDomain, setMailgunDomain] = useState("");
  const [claudeBudget, setClaudeBudget] = useState("2");
  const [retentionDays, setRetentionDays] = useState("365");
  /**
   * Copy settings from an existing workspace (P6/6.1).
   *
   * Provisioning gives a new workspace the DEFAULTS. That is the right floor
   * and the wrong ceiling: an agency that spent a year tuning its quote rules,
   * custom fields and letterhead does not want to do it again for the second
   * company it runs.
   */
  const [copyFrom, setCopyFrom] = useState(copyableWorkspaces[0]?.id ?? "");
  const [copyGroups, setCopyGroups] = useState<string[]>([]);

  if (!isOwner) {
    return (
      <div className="rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Workspaces</div>
        <p className="text-[12.5px] text-muted">Only an Owner can create workspaces.</p>
      </div>
    );
  }

  async function provision() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await createWorkspace({
        name, legalName, brandColor, logoUrl, mailgunDomain,
        claudeBudget: Number(claudeBudget), retentionDays: Number(retentionDays),
        ...(copyGroups.length > 0 && copyFrom ? { copyFrom, copyGroups } : {}),
      });
      if (res.ok) {
        setMsg(
          `Workspace created${res.copied ? `, and copied — ${res.copied}` : "."} Add people to it with Manage on its row above.`,
        );
        setName("");
        setLegalName("");
        setCopyGroups([]);
        router.refresh();
      } else setMsg(res.error);
    } catch (e) {
      // A throw used to leave the button disabled for good and say nothing —
      // the reported "Create workspace does nothing".
      setMsg(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Workspaces</div>
      <p className="mb-3 text-[11.5px] text-muted">Create a new workspace. You become its first Owner; add people from its row above. Audit-logged.</p>
      {msg && <p className="mb-3 text-[12px] text-[#C9CEE3]">{msg}</p>}

      <div className="grid gap-4">
        {/* provision */}
        <div className="grid gap-2 rounded-[11px] border border-line bg-panel-2 p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">New workspace</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name *" className={INPUT} />
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Legal name" className={INPUT} />
          <div className="flex gap-2">
            <label className="flex items-center gap-2 text-[12px] text-muted">
              Brand
              <input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} className="h-8 w-10 rounded border border-line bg-transparent" />
            </label>
            <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="Logo URL" className={`${INPUT} flex-1`} />
          </div>
          <input value={mailgunDomain} onChange={(e) => setMailgunDomain(e.target.value)} placeholder="Mailgun domain (placeholder)" className={INPUT} />
          <div className="flex gap-2">
            <label className="flex flex-1 items-center justify-between gap-2 text-[12px] text-muted">
              Claude $/day
              <input value={claudeBudget} onChange={(e) => setClaudeBudget(e.target.value)} inputMode="decimal" className={`${INPUT} w-20 text-right`} />
            </label>
            <label className="flex flex-1 items-center justify-between gap-2 text-[12px] text-muted">
              Retention (days)
              <input value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} inputMode="numeric" className={`${INPUT} w-20 text-right`} />
            </label>
          </div>
          {copyableWorkspaces.length > 0 && (
            <div className="grid gap-1.5 rounded-[9px] border border-line bg-[rgba(0,5,29,0.35)] p-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                Copy settings from
              </div>
              <select
                value={copyFrom}
                onChange={(e) => setCopyFrom(e.target.value)}
                data-testid="copy-from"
                className={INPUT}
              >
                {copyableWorkspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <div className="grid gap-1">
                {COPY_GROUPS.map((g) => (
                  <label key={g.key} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={copyGroups.includes(g.key)}
                      onChange={(e) =>
                        setCopyGroups((cur) =>
                          e.target.checked ? [...cur, g.key] : cur.filter((x) => x !== g.key),
                        )
                      }
                      data-testid={`copy-group-${g.key}`}
                      style={{ accentColor: "#7427C6" }}
                      className="mt-[3px]"
                    />
                    <span className="min-w-0">
                      <b className="block text-[12px] text-[#C9CEE3]">{g.label}</b>
                      <span className="block text-[11px] leading-relaxed text-muted">{g.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setCopyGroups((cur) =>
                    cur.length === COPY_GROUPS.length ? [] : COPY_GROUPS.map((g) => g.key),
                  )
                }
                data-testid="copy-all"
                className="w-fit text-[11.5px] font-semibold text-[#C9CEE3] underline decoration-dotted"
              >
                {copyGroups.length === COPY_GROUPS.length ? "Egyiket sem" : "Mindet"}
              </button>
              <p className="text-[11px] leading-relaxed text-muted">
                Csak beállítások. Lead, cég, dokumentum, számla, napló, tag és
                API-kulcs <b>soha</b> nem jön át — az másik cég adata. A
                workflow szabályok kikapcsolva érkeznek.
              </p>
            </div>
          )}
          <button onClick={provision} disabled={busy || !name.trim()} className="mt-1 w-fit rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60">
            Create workspace
          </button>
        </div>
      </div>
    </div>
  );
}
