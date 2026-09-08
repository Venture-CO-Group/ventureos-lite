/**
 * The settings menu, as data (P8/3).
 *
 * ── WHY SETTINGS NEEDED SPLITTING AT ALL ────────────────────────────────────
 *
 * Both settings pages had grown into one scroll. `/settings/admin` rendered
 * twenty panels in a column — branding, custom fields, workflows, health
 * rules, targets, quote rules, audit scoring, audit watches, the audit log,
 * users, grants, integrations, API costs, webhooks, workspaces, the cold-email
 * sign-off, the invoicing key, the proposal queue and GDPR — and finding any
 * one of them meant knowing roughly how far down it lived. That is not a
 * settings screen, it is a settings document.
 *
 * ── ONE LIST, NOT THREE ─────────────────────────────────────────────────────
 *
 * The menu, the page headings and the "which section am I on" highlight all
 * read this file. The alternative is three literal lists that agree until the
 * day somebody renames a page in one of them, and a settings menu that points
 * at a heading nobody changed is the most annoying kind of stale.
 *
 * A plain module: pure data, so a test can assert that every declared section
 * has a route and every route is declared.
 */

export interface SettingsSection {
  /** The last path segment. Empty string for the index of each group. */
  slug: string;
  href: string;
  label: string;
  /** One line under the label in the menu, saying what lives there. */
  hint: string;
  /** Rendered only for a super admin. */
  superAdminOnly?: boolean;
  /** Rendered only for an Owner of the active workspace. */
  ownerOnly?: boolean;
}

/**
 * Your own settings. Every member sees all of these.
 *
 * The mailbox is deliberately here rather than under admin: it is YOUR
 * mailbox, and it once sat on the admin page — which on a one-person
 * installation looked fine and would have meant a second user could never
 * connect their own mail, because that page 404s for anybody else.
 */
export const PERSONAL_SECTIONS: readonly SettingsSection[] = [
  {
    slug: "",
    href: "/settings",
    label: "Profile",
    hint: "Your name, job title, photo, timezone and language.",
  },
  {
    slug: "security",
    href: "/settings/security",
    label: "Sign-in & security",
    hint: "Password, two-factor authentication, your active devices.",
  },
  {
    slug: "notifications",
    href: "/settings/notifications",
    label: "Notifications",
    hint: "What reaches you, and on which channel.",
  },
  {
    slug: "email",
    href: "/settings/email",
    label: "Email",
    hint: "Connect your own mailbox for the Inbox.",
  },
  {
    slug: "extension",
    href: "/settings/extension",
    label: "Browser extension",
    hint: "The LinkedIn capture extension and its tokens.",
  },
] as const;

/**
 * How the software behaves. Super admin only, as the page gate already says.
 *
 * Grouped by the question somebody arrives with, not by which module the code
 * lives in — "who can do what" is one page even though it touches memberships,
 * grants and teams, and "what does an audit score" is one page even though the
 * scoring and the watch list are different modules.
 */
export const ADMIN_SECTIONS: readonly SettingsSection[] = [
  {
    slug: "",
    href: "/settings/admin",
    label: "Overview",
    hint: "What is configured, and what is still on a default.",
  },
  {
    slug: "members",
    href: "/settings/admin/members",
    label: "Members & teams",
    hint: "Invite, suspend, roles, capabilities, teams, ownership.",
  },
  {
    slug: "workspace",
    href: "/settings/admin/workspace",
    label: "Workspace",
    hint: "Letterhead, menu visibility, custom fields, workflow rules, data quality.",
  },
  {
    slug: "sales",
    href: "/settings/admin/sales",
    label: "Sales & delivery",
    hint: "Targets, quote rules, account health, milestone templates.",
  },
  {
    slug: "audit",
    href: "/settings/admin/audit",
    label: "Site audit",
    hint: "What the opportunity score is made of, and re-audit watches.",
  },
  {
    slug: "integrations",
    href: "/settings/admin/integrations",
    label: "Integrations",
    hint: "API keys, what they cost, outbound webhooks, invoicing.",
  },
  {
    slug: "security",
    href: "/settings/admin/security",
    label: "Security & compliance",
    hint: "Two-factor policy, the audit log, GDPR erasure and retention.",
  },
  {
    slug: "workspaces",
    href: "/settings/workspaces",
    label: "Workspaces",
    hint: "Provision a workspace, copy settings into it, repair one.",
  },
] as const;

export function sectionsFor(group: "personal" | "admin"): readonly SettingsSection[] {
  return group === "admin" ? ADMIN_SECTIONS : PERSONAL_SECTIONS;
}

/**
 * Which menu entry is the current one.
 *
 * Matched on the full href rather than on the slug, because `/settings` and
 * `/settings/admin` are both index pages and a slug of `""` matches
 * everything. Longest match wins, so `/settings/admin/members` highlights
 * Members rather than Overview.
 */
export function activeSection(
  group: "personal" | "admin",
  pathname: string,
): SettingsSection | null {
  const candidates = sectionsFor(group).filter(
    (s) => pathname === s.href || pathname.startsWith(`${s.href}/`),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, s) => (s.href.length > best.href.length ? s : best));
}
