"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setGrant, type Member } from "@/modules/settings/actions";
import { denyToken, grantIsImplicit } from "@/lib/grants";

const GROUPS: Array<{ module: string; grants: string[] }> = [
  {
    module: "Documents",
    grants: [
      "documents.quote.create",
      "documents.contract.create",
      "documents.certificate.create",
      "documents.send",
    ],
  },
  { module: "Templates", grants: ["templates.edit"] },
  { module: "Signal Engine", grants: ["signal_engine.approve"] },
  { module: "Exports", grants: ["exports.run"] },
  // Everything below is daily work a BDR carries by default. It appears here
  // so an Owner can take a capability away from ONE person — which is the
  // point of grants — rather than so it can be handed out.
  { module: "Leads", grants: ["leads.delete"] },
  { module: "Data", grants: ["data.merge", "fields.manage"] },
  { module: "Workspace settings", grants: ["settings.manage"] },
  { module: "Public pages", grants: ["public_pages.manage"] },
  { module: "Sector reports", grants: ["sector_reports.manage"] },
  { module: "Audit log", grants: ["audit_log.read"] },
];

/**
 * What the capability actually lets someone do.
 *
 * The old label was the grant string with its module prefix stripped, which
 * reads fine for "quote · create" and not at all for "delete" sitting under a
 * heading called Leads — an Owner deciding whether to withdraw a capability
 * should not have to infer its blast radius from four words.
 */
const GRANT_DESCRIPTION: Record<string, string> = {
  "documents.quote.create": "Draft a quote from a template.",
  "documents.contract.create": "Draft a contract from a template.",
  "documents.certificate.create": "Draft a completion certificate.",
  "documents.send": "Email a finalised document to a client.",
  "templates.edit": "Change what every future document says.",
  "signal_engine.approve": "Accept or reject the weekly proposals.",
  "exports.run": "Export leads as CSV, Excel or a branded PDF.",
  "leads.delete": "Permanently erase leads, in one or in bulk, and roll back an import. Cascades to derived data.",
  "data.merge": "Merge two companies or two leads into one.",
  "fields.manage": "Add, rename and archive the workspace's own fields.",
  "settings.manage": "Targets, workflow rules, health thresholds, quote rules, the deals commit threshold.",
  "public_pages.manage": "Publish and withdraw audit share links and booking pages.",
  "sector_reports.manage": "Commission, generate and publish a sector report.",
  "audit_log.read": "Read who did what, across the whole workspace.",
};

function grantLabel(grant: string): string {
  return grant.split(".").slice(1).join(" · ") || grant;
}

export function SettingsGrants({
  members,
  isOwner,
}: {
  members: Member[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(userId: string, grant: string, enabled: boolean) {
    setBusy(`${userId}:${grant}`);
    setError(null);
    try {
      await setGrant({ userId, grant, enabled });
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-[1000px]">
      <h2 className="mb-1 font-display text-2xl font-bold lowercase tracking-display">
        users &amp; grants
      </h2>
      <p className="mb-4 text-[12.5px] text-muted">
        Capabilities are per user per workspace. The document ones — quotes,
        contracts, certificates, sending, and the templates they render from —
        are Owner-only until handed over here. Everything else every member
        already carries. Each change is written to the audit log —{" "}
        <span className="text-accent-ink">logged</span>.
      </p>
      {!isOwner && (
        <div className="mb-3 rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-[12.5px] text-warn">
          Read-only — only the workspace Owner can change grants.
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="grid gap-3">
        {members.map((m) => {
          /**
           * A tick nobody can untick, because the role already carries it.
           *
           * Owner and Admin carry everything. A BDR carries everything except
           * the document capabilities — so showing those as grantable, and the
           * rest as already held, is the only honest rendering of the rule in
           * `grantAllowed`.
           */
          const roleCarriesAll = m.role === "OWNER" || m.role === "ADMIN";
          return (
            <div key={m.userId} className="rounded-card border border-line bg-panel p-[18px]">
              <div className="mb-3 flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded-full bg-grad text-[12px] font-bold">
                  {m.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <b className="text-[13px]">{m.name}</b>
                  <span className="block text-[11.5px] text-muted">{m.email}</span>
                </div>
                <span className="ml-auto rounded-full bg-accent-soft px-2.5 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                  {m.role}
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {GROUPS.map((g) => (
                  <div key={g.module}>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                      {g.module}
                    </div>
                    {g.grants.map((grant) => {
                      const implicit = grantIsImplicit(m.role, grant);
                      const denied = m.grants.includes(denyToken(grant));
                      const checked = !denied && (implicit || m.grants.includes(grant));
                      const key = `${m.userId}:${grant}`;
                      /**
                       * An Owner's own capabilities are the only ones that stay
                       * locked. Everything a BDR carries by default is now
                       * un-tickable-back: a capability nobody can withdraw is
                       * not a capability, and the box used to render ticked and
                       * disabled, which said the opposite.
                       */
                      const locked = roleCarriesAll;
                      return (
                        <label
                          key={grant}
                          data-testid={`grant-${m.userId}-${grant}`}
                          title={GRANT_DESCRIPTION[grant]}
                          className="flex items-start gap-2 py-1 text-[12.5px] text-[#C9CEE3]"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!isOwner || locked || busy === key}
                            onChange={(e) => toggle(m.userId, grant, e.target.checked)}
                            style={{ accentColor: "#7427C6" }}
                            className="mt-[3px]"
                          />
                          <span>
                            {grantLabel(grant)}
                            {locked && (
                              <span className="ml-1 text-[10.5px] text-muted">· via role</span>
                            )}
                            {!locked && implicit && !denied && (
                              <span className="ml-1 text-[10.5px] text-muted">· default</span>
                            )}
                            {denied && (
                              <span className="ml-1 text-[10.5px] text-warn">· withdrawn</span>
                            )}
                            {GRANT_DESCRIPTION[grant] && (
                              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted">
                                {GRANT_DESCRIPTION[grant]}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
