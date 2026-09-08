/**
 * Which parts of the product this workspace wants to see.
 *
 * ── WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT ───────────────────────────
 *
 * "az admin settingsben tudjak funkciókat (menüpontokat) elrejteni, nem
 * mindenre van már most szükség."
 *
 * This is DECLUTTERING. A workspace that does not do cold email should not
 * have to look at Campaigns twenty times a day. Hiding an item removes it from
 * the sidebar, from the mobile tab bar and from the command palette.
 *
 * It is NOT a permission. The route stays reachable by its URL, and every
 * mutation behind it keeps exactly the role and grant checks it already had.
 * That distinction is deliberate and it is stated on the settings screen too,
 * because the failure mode of blurring it is severe: an Owner who believes
 * "hidden" means "denied" would hand out a role thinking a capability had been
 * removed, and it would not have been. If something must be denied, take the
 * capability away — that is what grants are for.
 *
 * Making it enforce access would also break the things that legitimately link
 * INTO a hidden screen: a notification, an audit share link, a task pointing at
 * a document. Decluttering a menu must not turn those into dead ends.
 *
 * Pure over `Workspace.featureFlags`, so the resolution is testable without a
 * database and one place decides it for every surface.
 */

export interface NavFeature {
  /** Stable key, stored in featureFlags. Never the label — labels change. */
  key: string;
  /** What the sidebar calls it. */
  label: string;
  /** The route, for the palette and the nav row. */
  href: string;
  /**
   * Items a workspace cannot switch off, because switching them off would
   * leave somebody with no way back to their own data or their own settings.
   */
  essential?: boolean;
  /** One line explaining what turning it off costs. */
  hint?: string;
}

/**
 * Every hideable surface, keyed.
 *
 * The order matches the sidebar so the settings screen reads like the thing it
 * configures. Keys are stable identifiers: renaming "Lead Engine" in the UI
 * must not silently un-hide it in every workspace that had hidden it.
 */
export const NAV_FEATURES: readonly NavFeature[] = [
  { key: "dashboard", label: "Dashboard", href: "/", essential: true, hint: "The landing screen." },
  { key: "prospector", label: "Prospector", href: "/prospector", hint: "Finding businesses on Google Places." },
  { key: "leads", label: "Lead Engine", href: "/leads", essential: true, hint: "Where the leads are. Hiding it would leave no way to reach them." },
  { key: "audit", label: "Site Audit", href: "/audit", hint: "Website auditing and the audit reports." },
  { key: "pipeline", label: "Pipeline", href: "/pipeline", essential: true, hint: "The sales board." },
  { key: "deals", label: "Deals", href: "/deals", hint: "The money board, after Qualified." },
  { key: "outreach", label: "Outreach", href: "/outreach", hint: "Drafting connection notes and follow-ups." },
  { key: "inbox", label: "Inbox", href: "/inbox", hint: "Replies and triage." },
  { key: "calls", label: "Calls", href: "/calls", hint: "The call list and callbacks." },
  { key: "meetings", label: "Meetings", href: "/meetings", hint: "Booked meetings and briefs." },
  { key: "referrers", label: "Referrers", href: "/referrers", hint: "The referral ledger." },
  { key: "tasks", label: "Tasks", href: "/tasks", hint: "Task boards." },
  { key: "campaigns", label: "Campaigns", href: "/campaigns", hint: "Cold email. Off in most workspaces anyway — it ships behind a counsel sign-off." },
  { key: "documents", label: "Documents", href: "/documents", hint: "Quotes, contracts and completion certificates." },
  { key: "projects", label: "Projects", href: "/projects", hint: "Post-sale delivery." },
  { key: "reports-admin", label: "Sector reports", href: "/reports-admin", hint: "Commissioning sector reports." },
  { key: "templates", label: "Templates", href: "/templates", hint: "Document and email bodies." },
  { key: "public-pages", label: "Public Pages", href: "/public-pages", hint: "Share links and booking pages." },
  { key: "content", label: "Content Hub", href: "/content", hint: "Content planning." },
  { key: "analytics", label: "Analytics", href: "/analytics", hint: "Reporting." },
  { key: "settings", label: "Settings", href: "/settings", essential: true, hint: "Your own profile and security." },
] as const;

/** Everything that may actually be switched off. */
export const HIDEABLE_FEATURES: readonly NavFeature[] = NAV_FEATURES.filter((f) => !f.essential);

const KEYS = new Set(NAV_FEATURES.map((f) => f.key));
const ESSENTIAL = new Set(NAV_FEATURES.filter((f) => f.essential).map((f) => f.key));

/** Map a route to its feature key, for the palette filter. */
export const FEATURE_BY_HREF: Record<string, string> = Object.fromEntries(
  NAV_FEATURES.map((f) => [f.href, f.key]),
);

/**
 * The hidden set for a workspace.
 *
 * Reads `featureFlags.hiddenNav`. Unknown keys are dropped rather than
 * preserved — a key left over from a removed feature would otherwise sit in the
 * column for ever, and an essential key smuggled in by hand must not be able to
 * hide the Lead Engine from everybody.
 */
export function hiddenFeatures(featureFlags: unknown): Set<string> {
  if (!featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return new Set();
  }
  const raw = (featureFlags as Record<string, unknown>).hiddenNav;
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.filter((k): k is string => typeof k === "string" && KEYS.has(k) && !ESSENTIAL.has(k)),
  );
}

/** Sanitise a submitted list before it is stored. */
export function sanitizeHidden(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return [
    ...new Set(
      keys.filter((k): k is string => typeof k === "string" && KEYS.has(k) && !ESSENTIAL.has(k)),
    ),
  ];
}

/** Is this route hidden for this workspace? */
export function isHrefHidden(href: string | undefined, hidden: Set<string>): boolean {
  if (!href) return false;
  const key = FEATURE_BY_HREF[href];
  return key ? hidden.has(key) : false;
}
