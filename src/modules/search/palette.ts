/**
 * What the ⌘K palette can do besides find things (playbook-v2 P7/3). Pure, so
 * the matching and the ordering are testable without a browser.
 *
 * The palette is built ON the P3/1 search API rather than beside it: entities
 * come from `searchWorkspace`, and this module supplies the other half — the
 * verbs, and the recent-items list an empty query shows.
 */

import { foldText } from "./fuzzy";

export type PaletteActionId =
  | "new-lead"
  | "new-task"
  | "import"
  | "go-dashboard"
  | "go-portal"
  | "go-pipeline"
  | "go-deals"
  | "go-leads"
  | "go-inbox"
  | "go-calls"
  | "go-meetings"
  | "go-documents"
  | "go-analytics"
  | "go-forecast"
  | "go-content"
  | "go-projects"
  | "go-prospector"
  | "go-audit"
  | "go-outreach"
  | "go-campaigns"
  | "go-referrers"
  | "go-tasks"
  | "go-templates"
  | "go-public-pages"
  | "go-sector-reports"
  | "go-revenue"
  | "go-settings"
  | "go-admin-settings"
  | "run-audit"
  | "shortcuts";

export interface PaletteAction {
  id: PaletteActionId;
  label: string;
  /** Extra words that should find it. "new lead" is also "add", "capture". */
  keywords: string[];
  /** Where it goes, when it is just navigation. */
  href?: string;
  /** The keyboard shortcut to display beside it. */
  hint?: string;
  group: "action" | "navigate";
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  {
    id: "new-lead",
    label: "New lead",
    keywords: ["add", "capture", "create", "contact", "person"],
    hint: "n",
    group: "action",
  },
  {
    id: "new-task",
    label: "New task",
    keywords: ["add", "todo", "follow up", "call back", "reminder"],
    hint: "t",
    group: "action",
  },
  {
    id: "import",
    label: "Start an import",
    keywords: ["csv", "upload", "bulk", "spreadsheet"],
    group: "action",
  },
  {
    id: "run-audit",
    label: "Run an audit on…",
    keywords: ["website", "site", "check", "score"],
    href: "/audit",
    group: "action",
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    keywords: ["help", "keys", "hotkeys"],
    hint: "?",
    group: "action",
  },
  { id: "go-dashboard", label: "Go to Dashboard", keywords: ["home", "today"], href: "/", hint: "g d", group: "navigate" },
  { id: "go-leads", label: "Go to Lead Engine", keywords: ["leads", "table"], href: "/leads", hint: "g l", group: "navigate" },
  { id: "go-pipeline", label: "Go to Pipeline", keywords: ["board", "kanban", "stages"], href: "/pipeline", hint: "g p", group: "navigate" },
  { id: "go-deals", label: "Go to Deals", keywords: ["money", "board", "forecast"], href: "/deals", hint: "g e", group: "navigate" },
  { id: "go-inbox", label: "Go to Inbox", keywords: ["replies", "email", "mail"], href: "/inbox", hint: "g i", group: "navigate" },
  { id: "go-calls", label: "Go to Calls", keywords: ["phone", "callback"], href: "/calls", hint: "g c", group: "navigate" },
  { id: "go-meetings", label: "Go to Meetings", keywords: ["calendar", "booking"], href: "/meetings", hint: "g m", group: "navigate" },
  { id: "go-documents", label: "Go to Documents", keywords: ["quote", "contract", "certificate"], href: "/documents", hint: "g o", group: "navigate" },
  { id: "go-analytics", label: "Go to Analytics", keywords: ["report", "numbers", "revenue"], href: "/analytics", hint: "g a", group: "navigate" },
  { id: "go-forecast", label: "Go to Forecast", keywords: ["weighted", "pipeline value", "commit"], href: "/analytics?tab=forecast", group: "navigate" },
  { id: "go-content", label: "Go to Content Hub", keywords: ["posts", "linkedin", "blog"], href: "/content", group: "navigate" },
  /**
   * Destinations added as the product grew. A palette that cannot reach half
   * the nav is a palette people stop opening.
   *
   * Only Projects earns a `g` binding: the two-key map is for the handful of
   * boards somebody opens every day, and inventing a mnemonic for every page
   * fills it with bindings nobody can recall. The rest are found by typing
   * their name, which is what a palette is for.
   */
  { id: "go-projects", label: "Go to Projects", keywords: ["delivery", "milestone", "checklist", "teljesites"], href: "/projects", hint: "g r", group: "navigate" },
  /**
   * The client portal (P6/6.3).
   *
   * Listed even though staff have no client access: it is a real page, and the
   * palette-coverage test holds every nav entry to being reachable. An Owner
   * landing here sees the page explain that it is for client accounts, which is
   * a more useful answer than a search that finds nothing.
   */
  { id: "go-portal", label: "Go to the client portal", keywords: ["client", "portal", "kliens", "delivery"], href: "/portal", group: "navigate" },
  { id: "go-prospector", label: "Go to Prospector", keywords: ["google", "places", "find businesses", "search area"], href: "/prospector", group: "navigate" },
  { id: "go-audit", label: "Go to Site Audit", keywords: ["website", "score", "report"], href: "/audit", group: "navigate" },
  { id: "go-outreach", label: "Go to Outreach", keywords: ["message", "draft", "sequence"], href: "/outreach", group: "navigate" },
  { id: "go-campaigns", label: "Go to Campaigns", keywords: ["cold", "email", "sequence"], href: "/campaigns", group: "navigate" },
  { id: "go-referrers", label: "Go to Referrers", keywords: ["referral", "partner", "ledger"], href: "/referrers", group: "navigate" },
  { id: "go-tasks", label: "Go to Tasks", keywords: ["board", "todo", "kanban", "subtask", "assign"], href: "/tasks", hint: "g t", group: "navigate" },
  { id: "go-templates", label: "Go to Templates", keywords: ["quote", "contract", "letter", "email body"], href: "/templates", group: "navigate" },
  { id: "go-sector-reports", label: "Go to Sector reports", keywords: ["industry", "report", "batch", "szektor", "lead magnet"], href: "/reports-admin", group: "navigate" },
  { id: "go-public-pages", label: "Go to Public Pages", keywords: ["share", "links", "who viewed"], href: "/public-pages", group: "navigate" },
  { id: "go-revenue", label: "Go to Revenue", keywords: ["mrr", "subscription", "commission", "health"], href: "/analytics?tab=revenue", group: "navigate" },
  {
    id: "go-settings",
    label: "Go to Settings",
    // What is actually on /settings after the split: the person, not the
    // software. Fields, users and grants moved to Admin settings below.
    keywords: ["profile", "password", "2fa", "notifications", "mailbox", "security"],
    href: "/settings",
    hint: "g s",
    group: "navigate",
  },
  {
    id: "go-admin-settings",
    label: "Go to Admin settings",
    keywords: ["fields", "users", "grants", "integrations", "budget", "branding", "rules", "templates"],
    href: "/settings/admin",
    group: "navigate",
  },
];

/**
 * The `g`-prefixed navigation map (P7/3).
 *
 * Derived from the actions rather than listed twice: a hint of "g p" IS the
 * binding, so the two can never disagree — which is exactly how a help overlay
 * ends up documenting a shortcut that was renamed.
 */
export const GOTO_MAP: Record<string, string> = Object.fromEntries(
  PALETTE_ACTIONS.filter((a) => a.hint?.startsWith("g ") && a.href).map((a) => [
    a.hint!.slice(2),
    a.href!,
  ]),
);

/**
 * Match actions against what has been typed.
 *
 * Every term must match SOMETHING — the label or a keyword — so a second word
 * narrows rather than widens, the way every command palette a person has used
 * behaves. A label match outranks a keyword match, because "new lead" typed in
 * full should not be beaten by something that merely lists it as a synonym.
 */
export function matchActions(query: string, actions: PaletteAction[] = PALETTE_ACTIONS): PaletteAction[] {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ action: PaletteAction; score: number }> = [];
  for (const action of actions) {
    const label = foldText(action.label);
    const keywords = action.keywords.map(foldText);
    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      if (label.startsWith(term)) score += 3;
      else if (label.includes(term)) score += 2;
      else if (keywords.some((k) => k.startsWith(term))) score += 1;
      else if (keywords.some((k) => k.includes(term))) score += 0.5;
      else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) scored.push({ action, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label))
    .map((s) => s.action);
}

// ---- recent items ----------------------------------------------------------

export interface RecentItem {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  atMs: number;
}

export const MAX_RECENTS = 6;
const STORAGE_KEY = "vos.palette.recents";

/**
 * What an empty palette shows.
 *
 * Stored per browser rather than per user on the server: "the four things I
 * looked at this morning" is a property of the tab, not of the account, and
 * writing a row on every entity open to power a convenience list is not a
 * trade worth making.
 */
export function readRecents(raw: string | null): RecentItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentItem =>
          !!r &&
          typeof r === "object" &&
          typeof (r as RecentItem).id === "string" &&
          typeof (r as RecentItem).href === "string" &&
          typeof (r as RecentItem).title === "string",
      )
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Newest first, de-duplicated by href, bounded. */
export function pushRecent(current: RecentItem[], item: RecentItem): RecentItem[] {
  return [item, ...current.filter((r) => r.href !== item.href)].slice(0, MAX_RECENTS);
}

export const RECENTS_STORAGE_KEY = STORAGE_KEY;
