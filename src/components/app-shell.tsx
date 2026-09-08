import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getShellContext } from "@/modules/workspaces/actions";
import type { BudgetStatus } from "@/lib/ai/budget-status";
import { NotificationBell } from "./notification-bell";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { isHrefHidden } from "@/modules/workspaces/nav-visibility";
import { MobileNav, type MobileNavItem } from "./mobile-nav";
import { GlobalSearch } from "./global-search";
import { Greeting } from "./greeting";
import { AppActionsProvider } from "./app-actions";
import { UndoProvider } from "./undo-toast";
import { AppDialogs } from "./app-dialogs";
import { CommandPalette } from "./command-palette";
import { TopBarActions } from "./top-bar-actions";
import { AccountMenu } from "./account-menu";
import { SidebarNav } from "./sidebar-nav";
import {
  DashboardIcon,
  ProspectorIcon,
  SearchIcon,
  AuditIcon,
  PipelineIcon,
  DealsIcon,
  InboxIcon,
  CallsIcon,
  MeetingsIcon,
  ReferrersIcon,
  CampaignsIcon,
  DocumentsIcon,
  ProjectsIcon,
  TasksIcon,
  ReportsIcon,
  TemplatesIcon,
  PublicIcon,
  ContentIcon,
  AnalyticsIcon,
  SettingsIcon,
  OutreachIcon,
  MoreIcon,
} from "./nav-icons";

type NavItem = {
  label: string;
  icon: ReactNode;
  href?: string;
  count?: number;
  locked?: boolean;
};

// Nav mirroring docs/prototype.html. Items gain hrefs as their screens land.
const NAV: NavItem[] = [
  { label: "Dashboard", icon: <DashboardIcon />, href: "/" },
  { label: "Prospector", icon: <ProspectorIcon />, href: "/prospector" },
  { label: "Lead Engine", icon: <SearchIcon />, href: "/leads" },
  { label: "Site Audit", icon: <AuditIcon />, href: "/audit" },
  { label: "Pipeline", icon: <PipelineIcon />, href: "/pipeline" },
  // Deliberately right after Pipeline: the two boards are one journey split at
  // Qualified, and putting them side by side is half of explaining the boundary.
  { label: "Deals", icon: <DealsIcon />, href: "/deals" },
  { label: "Outreach", icon: <OutreachIcon />, href: "/outreach" },
  { label: "Inbox", icon: <InboxIcon />, href: "/inbox" },
  { label: "Calls", icon: <CallsIcon />, href: "/calls" },
  { label: "Meetings", icon: <MeetingsIcon />, href: "/meetings" },
  { label: "Referrers", icon: <ReferrersIcon />, href: "/referrers" },
  // Boards for work that has steps. Distinct from Projects, which is a
  // post-sale delivery engagement — see src/modules/tasks/board-logic.ts.
  { label: "Tasks", icon: <TasksIcon />, href: "/tasks" },
  { label: "Campaigns", icon: <CampaignsIcon />, href: "/campaigns", locked: true },
  { label: "Documents", icon: <DocumentsIcon />, href: "/documents", locked: true },
  // Between Documents and Templates on purpose: a project is the thing that
  // carries a signed contract to its certificate (P11/2).
  { label: "Projects", icon: <ProjectsIcon />, href: "/projects" },
  // The sector-report builder (v4 P12/2). Owner-gated at the page itself.
  { label: "Sector reports", icon: <ReportsIcon />, href: "/reports-admin" },
  // Quote/contract/certificate bodies AND the transactional email bodies —
  // one editor, switched by type. It had no nav entry, so neither was
  // reachable even though both were built and seeded.
  { label: "Templates", icon: <TemplatesIcon />, href: "/templates" },
  { label: "Public Pages", icon: <PublicIcon />, href: "/public-pages" },
  { label: "Content Hub", icon: <ContentIcon />, href: "/content" },
  { label: "Analytics", icon: <AnalyticsIcon />, href: "/analytics" },
];

const SETTINGS_ITEM: NavItem = { label: "Settings", icon: <SettingsIcon />, href: "/settings" };

/**
 * The four screens the daily loop runs through (spec §11.10) get a permanent
 * tab; everything else lives behind "More".
 */
const PRIMARY_MOBILE = ["Dashboard", "Pipeline", "Inbox", "Calls"];

function NavRow({ item, activePath }: { item: NavItem; activePath?: string }) {
  const active = item.href ? item.href === activePath : false;
  const className = [
    // min-h-[44px] keeps the sidebar usable on a touch laptop/tablet too.
    "flex min-h-[44px] items-center gap-2.5 rounded-[10px] border px-2.5 py-2 font-medium transition-colors",
    active
      ? "border-line bg-panel-2 text-ink [&_svg]:text-accent-2"
      : "cursor-pointer border-transparent text-muted hover:bg-panel hover:text-ink",
  ].join(" ");
  const inner = (
    <>
      <span className="h-4 w-4 flex-none [&_svg]:h-4 [&_svg]:w-4">{item.icon}</span>
      <span>{item.label}</span>
      {item.count !== undefined && (
        <span className="ml-auto rounded-full bg-accent-soft px-2 py-px text-[11px] font-semibold text-accent-ink tabular-nums">
          {item.count}
        </span>
      )}
      {item.locked && <span className="ml-auto text-[10px] opacity-70">🔒</span>}
    </>
  );
  return item.href ? (
    <Link href={item.href} className={className}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}

/**
 * Claude budget meter. Real spend for today against this workspace's cap
 * (CLAUDE.md hard rule #3) — the same figures the enforcement path uses, so the
 * bar and the block can never disagree. Turns amber past 80% and red once AI
 * calls are actually refused.
 */
function BudgetMeter({
  budget,
  compact = false,
}: {
  budget: BudgetStatus;
  compact?: boolean;
}) {
  // Same reasoning as the workspace switcher: both variants are in the DOM.
  const testId = compact ? "budget-meter-mobile" : "budget-meter";
  const tone = budget.exhausted ? "bg-neg" : budget.pct >= 80 ? "bg-warn" : "bg-grad";
  const label = `Claude budget: ${budget.spentLabel} of ${budget.capLabel} used today`;

  if (compact) {
    return (
      <div
        className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted"
        title={label}
        data-testid={testId}
      >
        <span aria-hidden>✦</span>
        <span className={budget.exhausted ? "text-neg" : "text-ink"}>{budget.spentLabel}</span>
        <span aria-hidden>/</span>
        <span>{budget.capLabel}</span>
      </div>
    );
  }

  return (
    <div className="border-t border-line px-2.5 pb-3 pt-2.5" data-testid={testId}>
      <div className="mb-2 flex justify-between text-[10.5px] text-muted">
        <span>✦ Claude budget</span>
        <b className={`font-semibold tabular-nums ${budget.exhausted ? "text-neg" : "text-ink"}`}>
          {budget.spentLabel} / {budget.capLabel}
        </b>
      </div>
      <div
        className="h-[3px] overflow-hidden rounded-[3px] bg-line"
        role="progressbar"
        aria-valuenow={budget.pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <i className={`block h-full rounded-[3px] ${tone}`} style={{ width: `${budget.pct}%` }} />
      </div>
      {budget.exhausted && (
        <p className="mt-1.5 text-[10.5px] leading-snug text-neg">
          Cap reached — AI calls resume at midnight UTC. Everything else keeps working.
        </p>
      )}
    </div>
  );
}

export async function AppShell({
  children,
  activePath,
}: {
  children?: ReactNode;
  activePath?: string;
}) {
  const shell = await getShellContext();
  // An Owner reset this account's second factor: nothing in the app is
  // reachable until a new authenticator is registered. Every authenticated
  // screen renders through this shell, so gating here covers all of them.
  /**
   * No authenticator, and one is required (P5/5.1).
   *
   * Two reasons reach here: an Owner reset this person's second factor, or the
   * workspace now requires one from everybody. Either way nothing in the app
   * is reachable until they enrol, and every authenticated screen renders
   * through this shell — so gating here covers all of them.
   */
  if (shell.enrolmentReason) {
    redirect(`/enroll-2fa?why=${shell.enrolmentReason}`);
  }
  const active = shell.workspaces.find((w) => w.active);
  const firstName = shell.user.name.split(" ")[0].toLowerCase();

  /**
   * What this workspace has switched off (see modules/workspaces/nav-visibility).
   *
   * Filtered here, once, so the sidebar, the mobile tab bar and the "More"
   * sheet cannot disagree about what exists. Decluttering only: the routes stay
   * reachable and every check behind them is untouched.
   */
  const hidden = new Set(shell.hiddenNav);
  const nav = NAV.filter((i) => !isHrefHidden(i.href, hidden));
  const allItems = [...nav, SETTINGS_ITEM];
  const icons: Record<string, ReactNode> = Object.fromEntries([
    ...allItems.map((i) => [i.label, i.icon] as const),
    ["More", <MoreIcon key="more" />] as const,
  ]);
  // A phone tab whose screen has been hidden would be a tab that leads
  // somewhere the workspace said it does not want; drop it and let the
  // remaining tabs take the width.
  const primary: MobileNavItem[] = PRIMARY_MOBILE.filter((label) =>
    allItems.some((i) => i.label === label),
  ).map((label) => {
    const item = allItems.find((i) => i.label === label);
    return { label, href: item?.href, locked: item?.locked };
  });
  const secondary: MobileNavItem[] = allItems
    .filter((i) => !PRIMARY_MOBILE.includes(i.label))
    .map((i) => ({ label: i.label, href: i.href, locked: i.locked }));

  return (
    <AppActionsProvider>
      <UndoProvider>
      {/* 100dvh, not 100vh: on a mobile browser vh ignores the collapsing
          toolbar, leaving the shell taller than the visible area. On desktop
          the two are identical. A fixed height (not min-height) from `nav:` up
          clamps the sidebar to the viewport so it scrolls internally instead
          of extending the page. */}
    <div className="relative z-10 flex min-h-[100dvh] flex-col nav:grid nav:h-[100dvh] nav:grid-cols-[228px_1fr] nav:overflow-hidden">
      {/* ---------- sidebar (nav: and up) ---------- */}
      {/* min-h-0 is what makes this scroll. A grid item defaults to
          min-height:auto, so the sidebar grew to fit its content — 1041px in an
          800px viewport — and the budget meter and profile block below it were
          simply off-screen and unreachable. Clamping it lets the nav region
          scroll while the header and footer stay pinned. */}
      <aside className="hidden h-full min-h-0 flex-col overflow-hidden border-r border-line bg-canvas/60 px-3.5 py-5 nav:flex">
        <div className="flex-none">
          <WorkspaceSwitcher
            workspaces={shell.workspaces}
            canManage={shell.role === "OWNER"}
          />
        </div>

        <div className="flex-none px-2.5 pb-5 pt-3 font-display text-[22px] tracking-display">
          <b className="font-extrabold">{shell.brand.markBold}</b>
          {shell.brand.markLight ? (
            <span className="ml-1.5 font-light text-muted">{shell.brand.markLight}</span>
          ) : null}
          {/* No edition badge. The wordmark stands alone: at the narrowest
              desktop sidebar width a third element pushed the lockup past the
              available space and wrapped, and the product is "Venture OS" — there
              is no other edition for a badge to distinguish it from. */}
        </div>

        <SidebarNav>
          {nav.map((item) => (
            <NavRow key={item.label} item={item} activePath={activePath} />
          ))}
          <div className="px-2.5 pb-1.5 pt-3.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            System
          </div>
          <NavRow item={SETTINGS_ITEM} activePath={activePath} />
        </SidebarNav>

        <div className="flex-none">
          <BudgetMeter budget={shell.budget} />
        </div>

        <div className="flex flex-none items-center gap-2.5 border-t border-line p-2.5">
          {/* Their own photo where they are represented, initials where there is
              none. The gradient disc stays the fallback rather than the only
              option — an uploaded picture that appears in Settings and nowhere
              else is a setting, not a profile. */}
          {shell.user.avatarUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- authenticated
               route; next/image's optimiser cannot fetch it */
            <img
              src={shell.user.avatarUrl}
              alt=""
              width={30}
              height={30}
              data-testid="shell-avatar"
              className="h-[30px] w-[30px] flex-none rounded-full border border-line object-cover"
            />
          ) : (
            <div className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full bg-grad text-[12px] font-bold">
              {shell.user.initials || "U"}
            </div>
          )}
          <div className="min-w-0 leading-tight">
            <b className="block truncate text-[13px]" data-testid="active-user">
              {shell.user.name}
            </b>
            <span className="block truncate text-[11px] text-muted">
              {shell.role} · {active?.name ?? ""}
            </span>
          </div>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* Phone header: workspace + budget only. The greeting and the desktop
            actions are dropped here — at 390px the screen belongs to content. */}
        <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-3 nav:hidden">
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher
              workspaces={shell.workspaces}
              canManage={shell.role === "OWNER"}
              testId="active-workspace-mobile"
            />
          </div>
          <BudgetMeter budget={shell.budget} compact />
          {/* Kept on the phone header: the playbook's whole point is triage on
              the move, and the bell is the one control that cannot be dropped
              at 390px without defeating it. */}
          <NotificationBell
            initialUnread={shell.unreadNotifications}
            testId="notification-bell-mobile"
          />
        </header>

        <header className="hidden flex-none items-center gap-3 border-b border-line px-7 py-4 nav:flex">
          <h1 className="min-w-0 truncate font-display text-[26px] font-extrabold lowercase tracking-display">
            <Greeting suffix={firstName} />
          </h1>
          <GlobalSearch className="ml-auto w-[clamp(180px,22vw,320px)] min-w-0 flex-none" />
          <NotificationBell initialUnread={shell.unreadNotifications} />
          <TopBarActions />
          <AccountMenu
            name={shell.user.name}
            email={shell.user.email}
            initials={shell.user.initials}
            avatarUrl={shell.user.avatarUrl}
            role={shell.role}
            workspaceName={active?.name ?? ""}
          />
        </header>

        {/* pb-24 clears the fixed tab bar; it collapses away at nav:. */}
        <main className="min-h-0 flex-1 overflow-x-hidden p-4 pb-24 nav:overflow-auto nav:p-7 nav:pb-7">
          {children}
        </main>
      </div>

      <MobileNav
        primary={primary}
        secondary={secondary}
        activePath={activePath}
        icons={icons}
      />
      <AppDialogs />
      <CommandPalette hiddenNav={shell.hiddenNav} />
    </div>
      </UndoProvider>
    </AppActionsProvider>
  );
}
