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
  /**
   * Added after the tour was first written (playbook-v5 P17/3). A guided tour
   * that stops at the features of six months ago teaches a smaller product
   * than the one somebody just signed into.
   */
  {
    id: "tasks",
    title: "work that has steps",
    body:
      "Boards for delivery work — columns, subtasks, dependencies, recurrence. Follow-ups raised from a lead stay on the dashboard and need no board.",
    href: "/tasks",
  },
  {
    id: "deals",
    title: "money you can forecast",
    body:
      "A qualified lead becomes a deal with a value and a close date, on its own pipeline, so the forecast is a sum of real numbers.",
    href: "/deals",
  },
  {
    id: "content",
    title: "the content hub",
    body:
      "One topic, written for several channels, moving from draft to approved. Claude drafts; a person approves and posts.",
    href: "/content",
  },
  {
    id: "settings",
    title: "make it yours",
    body: "Your own settings hold your photo, your password and 2FA, what reaches you, and your mailbox connection. The software's settings — letterhead, custom fields, who can do what, the Claude budget — live under Settings → Admin.",
    href: "/settings",
  },
];

export type ChecklistId =
  | "install_extension"
  | "connect_email"
  | "first_lead"
  | "first_audit"
  | "first_meeting"
  | "first_post";

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  hint: string;
  href: string;
}

/**
 * The first run, in the order somebody actually does it (playbook-v5 P17/3).
 *
 * ── WHAT CHANGED, AND WHY ───────────────────────────────────────────────────
 *
 * The playbook asks for the extension and the first post, which were missing:
 * the extension is how leads get captured from LinkedIn at all, so a checklist
 * that never mentions it leaves the main capture route undiscovered, and the
 * content hub shipped after this list was written.
 *
 * `connect_email` stays. It is not in the playbook's five, but connecting a
 * mailbox is what makes replies thread onto the lead they belong to, and
 * dropping a real step to match a count would be the wrong kind of tidy.
 */
export const CHECKLIST: ChecklistItem[] = [
  {
    id: "install_extension",
    label: "Install the capture extension",
    hint: "It is how a LinkedIn profile becomes a lead in one click.",
    href: "/settings/extension",
  },
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
  {
    id: "first_post",
    label: "Write your first post",
    hint: "Claude drafts in your brand voice; a human approves and posts.",
    href: "/content",
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
