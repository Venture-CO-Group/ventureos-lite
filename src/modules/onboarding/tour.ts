/**
 * The first-login tour and the getting-started checklist (playbook-v2 P7/4).
 * Pure: the steps, the checklist definition and the "is it done" rule.
 */

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Where "Take me there" goes, when the step has a place. */
  href?: string;
}

/**
 * Six steps, in the order the daily loop actually runs.
 *
 * Deliberately narrative rather than a feature list: someone opening this for
 * the first time needs to know what the DAY looks like, and a tour that points
 * at eleven buttons teaches nothing about which one to press first.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "dashboard",
    title: "your day starts here",
    body: "The dashboard is the morning screen: what is due, what came in overnight, and the week's insight from the Signal Engine.",
    href: "/",
  },
  {
    id: "capture",
    title: "capture a lead",
    body: "Add one by hand, paste a LinkedIn profile, run the prospector, or import a CSV. Nothing is scraped and nothing is sent automatically.",
    href: "/leads",
  },
  {
    id: "research",
    title: "research and score it",
    body: "Research runs when you ask it to — never on page load. It scores against your ICP, and a lead below the threshold cannot be contacted.",
    href: "/leads",
  },
  {
    id: "outreach",
    title: "draft the outreach",
    body: "Claude drafts; you edit and you send. A draft you have not changed cannot be marked as sent — that guardrail is not optional.",
    href: "/outreach",
  },
  {
    id: "pipeline",
    title: "work the pipeline",
    body: "Leads move Researched to Replied on the Pipeline board. From Qualified onward the money lives on a Deal, with its own board and forecast.",
    href: "/pipeline",
  },
  {
    id: "settings",
    title: "make it yours",
    body: "Your own settings hold your photo, your password and 2FA, what reaches you, and your mailbox connection. The software's settings — letterhead, custom fields, who can do what, the Claude budget — live under Settings → Admin.",
    href: "/settings",
  },
];

export type ChecklistId = "connect_email" | "first_lead" | "first_audit" | "first_meeting";

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  hint: string;
  href: string;
}

export const CHECKLIST: ChecklistItem[] = [
  {
    id: "connect_email",
    label: "Connect your mailbox",
    hint: "Correspondence threads onto the lead it belongs to.",
    href: "/settings/email",
  },
  {
    id: "first_lead",
    label: "Capture your first lead",
    hint: "By hand, from LinkedIn, from the prospector, or from a CSV.",
    href: "/leads",
  },
  {
    id: "first_audit",
    label: "Run your first site audit",
    hint: "It is the opening line that works: their own website, measured.",
    href: "/audit",
  },
  {
    id: "first_meeting",
    label: "Book your first meeting",
    hint: "From the app, or from your public booking page.",
    href: "/meetings",
  },
];

export type ChecklistState = Record<ChecklistId, boolean>;

export function checklistComplete(state: ChecklistState): boolean {
  return CHECKLIST.every((item) => state[item.id]);
}

export function checklistProgress(state: ChecklistState): { done: number; total: number } {
  return {
    done: CHECKLIST.filter((item) => state[item.id]).length,
    total: CHECKLIST.length,
  };
}
