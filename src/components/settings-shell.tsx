import type { ReactNode } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { activeSection, sectionsFor } from "@/modules/settings/sections";

/**
 * The frame every settings page renders inside (P8/3).
 *
 * ── WHY A SHELL AND NOT A LAYOUT FILE ───────────────────────────────────────
 *
 * A Next.js `layout.tsx` under `/settings` would wrap the admin pages too, and
 * the two groups have different menus and different gates — the admin group is
 * super-admin only and `notFound()`s rather than explaining itself. A layout
 * would have to branch on the pathname to decide which menu to draw, which is
 * the same conditional, just further from the pages it governs.
 *
 * It also keeps `AppShell` where it is. Each settings page still declares
 * `activePath="/settings"` through this, so the sidebar highlight stays right.
 */
export function SettingsShell({
  group,
  pathname,
  title,
  description,
  action,
  children,
}: {
  group: "personal" | "admin";
  /** The current route, for the menu highlight. Passed in: this is a server component. */
  pathname: string;
  title: string;
  description: string;
  /** Optional control in the heading — "back to your settings", say. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const sections = sectionsFor(group);
  const active = activeSection(group, pathname);

  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold lowercase tracking-display">
              {title}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>
          </div>
          {action}
        </div>

        {/*
          The menu is a column beside the content on a wide screen and a row of
          chips above it on a phone. Not a `<select>`: a settings menu is the
          one place where seeing every option at once is the feature, and eight
          entries in a dropdown is eight entries nobody knows about.
        */}
        <div className="grid gap-4 lg:grid-cols-[220px_1fr] lg:items-start">
          <nav
            data-testid="settings-nav"
            aria-label={group === "admin" ? "Admin settings sections" : "Settings sections"}
            className="flex gap-1.5 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:flex-col lg:overflow-visible lg:pb-0"
          >
            {sections.map((s) => {
              const current = active?.href === s.href;
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  data-testid={`settings-nav-${s.slug || "index"}`}
                  aria-current={current ? "page" : undefined}
                  className={`flex-none rounded-[10px] border px-3 py-2 transition-colors lg:flex-auto ${
                    current
                      ? "border-accent bg-accent-soft text-ink"
                      : "border-line bg-panel text-muted hover:border-accent hover:text-ink"
                  }`}
                >
                  <b className="block whitespace-nowrap text-[12.5px] font-semibold lg:whitespace-normal">
                    {s.label}
                  </b>
                  {/* The hint is the difference between a menu and a list of
                      words. Hidden on a phone, where the chips scroll. */}
                  <span className="mt-0.5 hidden text-[11px] leading-snug text-muted lg:block">
                    {s.hint}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="grid min-w-0 gap-4">{children}</div>
        </div>
      </div>
    </AppShell>
  );
}
