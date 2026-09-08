import { notFound } from "next/navigation";
import { isSuperAdmin } from "@/lib/authz";

/**
 * The gate every admin settings page runs first (P8/3).
 *
 * ── WHY `notFound()` AND NOT A REFUSAL ──────────────────────────────────────
 *
 * A page that answers "you may not see this" has told somebody it exists. This
 * one does not need to.
 *
 * ── WHY IT IS A HELPER AND NOT A LAYOUT ─────────────────────────────────────
 *
 * A Next.js layout would gate the group in one place, which is tidier — and
 * would also mean a new page added under this directory is protected by
 * something a page author cannot see from the page. Seven files calling one
 * named function is a check that is visible where it matters, and the
 * unit test over the route table is what makes sure nobody forgets it.
 *
 * The panels keep every check they already had: each is Owner-gated inside its
 * own server actions. This is ON TOP of those, never instead — a page-level
 * check protects a page, and the only thing that protects a mutation is the
 * mutation.
 */
export async function requireSuperAdminPage(): Promise<void> {
  if (!(await isSuperAdmin())) notFound();
}
