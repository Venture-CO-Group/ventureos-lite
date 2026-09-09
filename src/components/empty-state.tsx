import type { ReactNode } from "react";
import { StateCard } from "./state-card";

/**
 * The empty state, once, everywhere (playbook-v2 P7/4).
 *
 * "No campaigns yet." is not an empty state — it is a status line. What an
 * empty screen has to do is say what the module IS FOR and hand over the one
 * action that makes it non-empty, because the person looking at it is usually
 * seeing that screen for the first time and has no other source for either.
 *
 * ── NOW A BINDING RATHER THAN A CARD ────────────────────────────────────────
 *
 * `StateCard` (playbook-v5 P17/3) owns the three modes a list can be empty
 * FOR — nothing yet, a filter that matched nothing, and a failure — because
 * those need three different next actions and collapsing them is how a screen
 * stops being useful. This is the first of the three, kept under its own name
 * so its eleven call sites did not have to change.
 */
export function EmptyState({
  title,
  children,
  action,
  secondary,
  testId,
  inset = false,
}: {
  /** Lowercase, a few words. "no leads yet", not "No Leads Found". */
  title: string;
  /** One sentence on what this module does. */
  children: ReactNode;
  action?: { label: string; href?: string; onClick?: never } | null;
  /** A quieter second option, when there genuinely is one. */
  secondary?: ReactNode;
  testId?: string;
  inset?: boolean;
}) {
  return (
    <StateCard
      mode="empty"
      title={title}
      action={action ?? null}
      secondary={secondary}
      testId={testId ?? "empty-state"}
      inset={inset}
    >
      {children}
    </StateCard>
  );
}
