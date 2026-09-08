import Link from "next/link";
import { SettingsShell } from "@/components/settings-shell";
import { requireSuperAdminPage } from "./gate";
import { ADMIN_SECTIONS } from "@/modules/settings/sections";
import { getAdminOverview } from "@/modules/settings/overview";

/**
 * Admin settings — the index (P8/3).
 *
 * ── WHAT THIS PAGE USED TO BE ───────────────────────────────────────────────
 *
 * Twenty panels in one column: branding, custom fields, workflows, health
 * rules, targets, quote rules, audit scoring, audit watches, the audit log,
 * users, grants, integrations, API costs, webhooks, workspaces, the cold-email
 * sign-off, the invoicing key, the proposal queue and GDPR. Finding any one of
 * them meant knowing roughly how far down it lived. That is not a settings
 * screen, it is a settings document.
 *
 * ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
 *
 * A map, with one line per section saying what is actually configured behind
 * it. Not a dashboard and not a summary of the product: the only question this
 * page answers is "where do I go, and is anything here still on a default I
 * meant to change". A default nobody chose is the thing that goes unnoticed
 * for a year, so it is the thing the index points at.
 */
export const dynamic = "force-dynamic";

export default async function AdminSettingsIndexPage() {
  await requireSuperAdminPage();
  const overview = await getAdminOverview();

  // The Overview row itself is dropped: a card linking to the page you are on.
  const cards = ADMIN_SECTIONS.filter((s) => s.slug !== "");

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin"
      title="admin settings"
      description="How the software behaves. Visible to super admins only."
      action={
        <Link
          href="/settings"
          className="min-h-[40px] rounded-[9px] border border-line bg-panel px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:border-accent"
        >
          ← Your settings
        </Link>
      }
    >
      <div className="grid gap-2.5 sm:grid-cols-2">
        {cards.map((s) => {
          const facts = overview[s.slug] ?? [];
          return (
            <Link
              key={s.href}
              href={s.href}
              data-testid={`admin-card-${s.slug}`}
              className="rounded-card border border-line bg-panel p-[18px] transition-colors hover:border-accent"
            >
              <b className="block font-display text-lg font-bold lowercase">{s.label}</b>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                {s.hint}
              </span>
              {facts.length > 0 && (
                <ul className="mt-2.5 grid gap-1 border-t border-line pt-2.5">
                  {facts.map((f) => (
                    <li key={f.label} className="flex items-baseline gap-2 text-[11.5px]">
                      <span className="text-muted">{f.label}</span>
                      <b
                        className={`ml-auto tabular-nums ${
                          f.attention ? "text-warn" : "text-ink"
                        }`}
                      >
                        {f.value}
                      </b>
                    </li>
                  ))}
                </ul>
              )}
            </Link>
          );
        })}
      </div>
    </SettingsShell>
  );
}
