"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getEntityHeader } from "@/modules/entities/header-actions";
import type { EntityHeader } from "@/modules/entities/header";
import { Modal } from "./modal";
import { EntityTasks } from "./entity-tasks";
import { StateCard } from "./state-card";

/**
 * A company or a deal, opened from the address bar (playbook-v5 P20/4).
 *
 * ── WHY A DRAWER AND NOT A PAGE ─────────────────────────────────────────────
 *
 * Both of these entities were already being LINKED to — from task cards, from
 * global search, from the project screen — and neither had anywhere to land.
 * A page each would have been two more routes to keep in step with the board
 * they belong to; a drawer over the board keeps the list behind it, so closing
 * it puts you back where you were rather than one navigation deeper.
 *
 * ── AND WHY IT IS MOSTLY THE TASK PANEL ─────────────────────────────────────
 *
 * The item this exists for is the reverse direction: what work is open on this
 * thing. The header is the few facts needed to know which company or deal you
 * are looking at; the panel is the point.
 */
export function EntityDrawer({
  kind,
  entityId,
  from,
  onClose,
}: {
  kind: "company" | "deal";
  entityId: string;
  /** Where the person came from, if they arrived through a link that said. */
  from?: string | null;
  onClose: () => void;
}) {
  const [header, setHeader] = useState<EntityHeader | null | "missing">(null);
  const [openCount, setOpenCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    getEntityHeader(kind, entityId)
      .then((h) => {
        if (active) setHeader(h ?? "missing");
      })
      .catch(() => {
        if (active) setHeader("missing");
      });
    return () => {
      active = false;
    };
  }, [kind, entityId]);

  return (
    <Modal onClose={onClose} labelledBy="entity-drawer-title">
      <div className="grid gap-3" data-testid="entity-drawer">
        {header === "missing" ? (
          <StateCard
            mode="error"
            title="this is not here any more"
            action={{ label: "Close", onClick: onClose }}
          >
            The {kind} this link points at has been deleted or belongs to another workspace.
          </StateCard>
        ) : header === null ? (
          <p className="text-[12px] text-muted">Loading…</p>
        ) : (
          <>
            <div>
              {/**
               * The way back, when the link that brought you here said where
               * it came from. Following a task out of a lead and coming back
               * should land on the lead, not at the top of a list.
               */}
              {from && (
                <Link
                  href={from}
                  data-testid="entity-drawer-back"
                  className="mb-1 inline-block text-[11px] text-accent-ink underline-offset-2 hover:underline"
                >
                  ← Back
                </Link>
              )}
              <h3
                id="entity-drawer-title"
                className="font-display text-[19px] font-extrabold lowercase"
                data-testid="entity-drawer-title"
              >
                {header.title.toLowerCase()}
                {openCount !== null && openCount > 0 && (
                  <span
                    data-testid="entity-header-task-badge"
                    title={`${openCount} open task${openCount === 1 ? "" : "s"}`}
                    className="ml-2 align-middle rounded-full border border-accent-soft px-1.5 text-[11px] font-normal tabular-nums text-accent-ink"
                  >
                    {openCount}
                  </span>
                )}
              </h3>
              {header.subtitle && <p className="text-[12px] text-muted">{header.subtitle}</p>}
            </div>

            {header.facts.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] sm:grid-cols-3">
                {header.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {fact.label}
                    </dt>
                    <dd className="truncate text-ink" title={fact.value}>
                      {fact.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <EntityTasks kind={kind} entityId={entityId} onCountChange={setOpenCount} />

            {header.actions.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-3 text-[12px]">
                {header.actions.map((action) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="text-accent-ink underline-offset-2 hover:underline"
                  >
                    {action.label} →
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
