"use client";

import type { ReactNode } from "react";
import Link from "next/link";

/**
 * The three things a list can have nothing in it FOR (playbook-v5 P17/3).
 *
 * ── WHY THREE MODES AND NOT ONE ─────────────────────────────────────────────
 *
 * "No results" covers three different situations that need three different
 * next actions, and collapsing them is how a screen becomes unhelpful:
 *
 *   EMPTY — nothing here yet. The person is usually seeing this module for the
 *     first time, so the screen has to say what it is FOR and hand over the
 *     one action that makes it non-empty.
 *   ZERO-RESULTS — there is plenty here, but the filter matched none of it.
 *     Saying "no leads" would be a lie. The only useful action is to undo the
 *     filter, so this mode OFFERS THAT rather than describing the module.
 *   ERROR — something failed. Not the person's fault and not a state to
 *     explain away, so it offers a retry and, where there is one, a link to
 *     what to check.
 *
 * Mistaking the second for the first is the common bug: a filtered table that
 * says "no leads yet — capture your first" to somebody with four hundred leads.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * `EmptyState` did the first mode well and is now the `empty` binding of this,
 * so its eleven call sites did not have to change.
 */

export type StateMode = "empty" | "zero-results" | "error";

const TONE: Record<StateMode, string> = {
  empty: "border-dashed border-line bg-[rgba(239,241,248,0.02)]",
  "zero-results": "border-line bg-panel",
  error: "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.06)]",
};

const HEADLINE: Record<StateMode, string> = {
  empty: "text-ink",
  "zero-results": "text-ink",
  error: "text-[#FFB3C2]",
};

export interface StateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function StateCard({
  mode,
  title,
  children,
  action,
  secondary,
  illustration,
  testId,
  inset = false,
}: {
  mode: StateMode;
  /** Lowercase, a few words. "no leads yet", not "No Leads Found". */
  title: string;
  /** One sentence. Two is a manual. */
  children: ReactNode;
  action?: StateAction | null;
  secondary?: ReactNode;
  /**
   * A glyph or small graphic. Optional and deliberately restrained: an
   * illustration that competes with the headline makes the screen decorative
   * rather than useful.
   */
  illustration?: ReactNode;
  testId?: string;
  /**
   * Drop the card of its own, for a state that sits INSIDE a panel — nested,
   * the default border draws a second one a few pixels inside the first.
   */
  inset?: boolean;
}) {
  return (
    <div
      data-testid={testId ?? `state-${mode}`}
      data-mode={mode}
      role={mode === "error" ? "alert" : undefined}
      className={
        inset ? "px-4 py-8 text-center" : `rounded-card border px-6 py-10 text-center ${TONE[mode]}`
      }
    >
      {illustration && (
        <div aria-hidden="true" className="mb-3 text-[26px] leading-none opacity-70">
          {illustration}
        </div>
      )}
      <h2 className={`font-display text-[22px] lowercase tracking-display ${HEADLINE[mode]}`}>
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-[440px] text-[13px] leading-relaxed text-muted">
        {children}
      </p>
      {(action || secondary) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action?.href && (
            <Link
              href={action.href}
              data-testid="state-action"
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
            >
              {action.label}
            </Link>
          )}
          {action && !action.href && (
            <button
              type="button"
              onClick={action.onClick}
              data-testid="state-action"
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
            >
              {action.label}
            </button>
          )}
          {secondary}
        </div>
      )}
    </div>
  );
}

/**
 * "There is plenty here, the filter matched none of it."
 *
 * The action is always the same, because there is only one useful one: undo
 * the filter. Describing the module here would be answering a question nobody
 * asked.
 */
export function ZeroResults({
  noun,
  onClear,
  testId = "zero-results",
  inset = false,
}: {
  /** Plural. "leads", "tasks", "posts". */
  noun: string;
  onClear: () => void;
  testId?: string;
  inset?: boolean;
}) {
  return (
    <StateCard
      mode="zero-results"
      title={`no ${noun} match this filter`}
      illustration="⌕"
      action={{ label: "Clear the filters", onClick: onClear }}
      testId={testId}
      inset={inset}
    >
      There are {noun} here — none of them match what you have narrowed to.
    </StateCard>
  );
}

/**
 * "Something failed."
 *
 * Not the person's fault, so no apology and no explanation of what went wrong
 * internally: a retry, and where relevant a link to the thing that is probably
 * misconfigured.
 */
export function ErrorState({
  title = "that did not load",
  detail,
  onRetry,
  check,
  testId = "error-state",
  inset = false,
}: {
  title?: string;
  /** One sentence, from the server where there is one. */
  detail?: string | null;
  onRetry?: () => void;
  /** Where to look, when there is somewhere. */
  check?: { label: string; href: string };
  testId?: string;
  inset?: boolean;
}) {
  return (
    <StateCard
      mode="error"
      title={title}
      illustration="⚠"
      action={onRetry ? { label: "Try again", onClick: onRetry } : null}
      secondary={
        check ? (
          <Link
            href={check.href}
            data-testid="error-check"
            className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-ink"
          >
            {check.label}
          </Link>
        ) : null
      }
      testId={testId}
      inset={inset}
    >
      {detail || "The server did not answer. Trying again usually settles it."}
    </StateCard>
  );
}
