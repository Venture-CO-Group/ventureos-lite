"use client";

import { useEffect, useState, useTransition } from "react";
import { formatHours } from "@/modules/tasks/time-logic";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { attempt, attemptVoid } from "@/lib/client/server-action";
import {
  getProject,
  closeProjectAction,
  addMilestone,
  type ProjectBoard,
  type ProjectDetail,
} from "@/modules/projects/actions";
import { completeTask, reopenTask } from "@/modules/tasks/actions";
import { EmptyState } from "./empty-state";
import { Modal } from "./modal";
import { EntityTasks } from "./entity-tasks";

const CARD = "rounded-card border border-line bg-panel p-4";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function isOverdue(iso: string | null, done: string | null): boolean {
  return !done && !!iso && new Date(iso).getTime() < Date.now();
}

/** A progress bar that says how much is left, not how pretty the project is. */
function Progress({ pct, overdue }: { pct: number; overdue: number }) {
  return (
    <div className="grid gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]">
        <div
          className={`h-full rounded-full ${overdue > 0 ? "bg-warn" : "bg-grad"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-muted">
        {pct}%{overdue > 0 && <span className="text-warn"> · {overdue} késésben</span>}
      </span>
    </div>
  );
}

export function Projects({ board }: { board: ProjectBoard }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<ProjectDetail | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [newTitle, setNewTitle] = useState("");
  /** Ad-hoc tasks on this project, for the header badge (playbook-v5 P20/4). */
  const [openTasks, setOpenTasks] = useState(0);

  /**
   * Deep link from the deal board: starting a project lands the operator on
   * the checklist itself rather than on a list they then have to search.
   */
  const deepLink = params.get("project");
  useEffect(() => {
    if (!deepLink || open) return;
    let cancelled = false;
    getProject(deepLink).then((detail) => {
      if (!cancelled) setOpen(detail);
    });
    return () => {
      cancelled = true;
    };
    // Only on arrival: re-running when `open` changes would reopen the modal
    // the moment somebody closed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink]);

  function openProject(id: string) {
    setMsg(null);
    startTransition(async () => {
      const detail = await getProject(id);
      setOpen(detail);
    });
  }

  function refreshOpen() {
    if (!open) return;
    startTransition(async () => {
      const detail = await getProject(open.id);
      setOpen(detail);
      router.refresh();
    });
  }

  /**
   * Completing a milestone completes its TASK.
   *
   * There is one done flag in the system, so this is not a mirror of the task
   * list — it is the task list, seen from the project.
   *
   * Optimistic, and it has to be: a checklist where the tick appears half a
   * second after the click is a checklist people click twice. The local state
   * moves first and rolls back if the server disagrees.
   */
  function toggle(taskId: string, done: boolean) {
    setMsg(null);
    const optimistic = done ? null : new Date().toISOString();
    setOpen((p) =>
      p
        ? {
            ...p,
            milestones: p.milestones.map((m) =>
              m.taskId === taskId ? { ...m, doneAt: optimistic } : m,
            ),
          }
        : p,
    );

    startTransition(async () => {
      const err = await attemptVoid(done ? reopenTask(taskId) : completeTask(taskId));
      if (err) {
        // Put it back exactly as it was, and say why.
        setOpen((p) =>
          p
            ? {
                ...p,
                milestones: p.milestones.map((m) =>
                  m.taskId === taskId ? { ...m, doneAt: done ? new Date().toISOString() : null } : m,
                ),
              }
            : p,
        );
        setMsg({ kind: "err", text: err });
        return;
      }
      refreshOpen();
    });
  }

  function close(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(closeProjectAction(id));
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setMsg({ kind: "ok", text: "Projekt lezárva." });
      refreshOpen();
    });
  }

  function add() {
    if (!open || !newTitle.trim()) return;
    startTransition(async () => {
      const res = await attempt(addMilestone({ projectId: open.id, title: newTitle }));
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setNewTitle("");
      refreshOpen();
    });
  }

  const rows = (list: ProjectBoard["active"]) =>
    list.map((p) => (
      <button
        key={p.id}
        onClick={() => openProject(p.id)}
        data-testid="project-row"
        className={`${CARD} grid gap-2 text-left transition-colors hover:border-accent`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
            <span className="block truncate text-[11.5px] text-muted">
              {p.companyName ?? "—"} · indult {when(p.startedAt)}
            </span>
          </div>
          {p.certificateIssued ? (
            <span className="shrink-0 rounded-full bg-[rgba(61,220,151,0.12)] px-2 py-0.5 text-[10.5px] font-semibold text-[#3DDC97]">
              TIG kiállítva
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[10.5px] font-semibold text-muted">
              {p.done}/{p.total}
            </span>
          )}
        </div>
        <Progress pct={p.pct} overdue={p.overdue} />

        {/**
         * What it was estimated at against what it has cost (playbook-v5
         * P20/1). Shown only once one of the two exists: a row of dashes on
         * every project would be noise, and this is the number the pricing
         * intelligence is built on.
         */}
        {(p.estimateMinutes > 0 || p.actualMinutes > 0) && (
          <span data-testid="project-cost" className="text-[11.5px] text-muted">
            Becslés <span className="text-ink">{formatHours(p.estimateMinutes || null)}</span> ·
            eddig <span className="text-ink">{formatHours(p.actualMinutes)}</span>
            {p.estimateMinutes > 0 && (
              <span
                className={
                  p.actualMinutes > p.estimateMinutes * 1.15
                    ? " text-warn"
                    : p.actualMinutes < p.estimateMinutes * 0.85
                      ? " text-pos"
                      : ""
                }
              >
                {" "}
                ({Math.round((p.actualMinutes / p.estimateMinutes) * 100)}%)
              </span>
            )}
          </span>
        )}
        {p.next && (
          <span className="text-[11.5px] text-muted">
            Következő: <span className="text-ink">{p.next.title}</span>
            {p.next.dueAt && (
              <span className={isOverdue(p.next.dueAt, null) ? " text-warn" : ""}>
                {" "}
                · {when(p.next.dueAt)}
              </span>
            )}
          </span>
        )}
      </button>
    ));

  return (
    <div className="max-w-[1100px]">
      {msg && (
        <div
          className={`mb-3 rounded-[10px] border px-3.5 py-2.5 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.1)] text-[#8FE9C3]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </div>
      )}

      <h2 className="mb-2 font-display text-[17px] font-bold lowercase">futó projektek</h2>
      {board.active.length === 0 ? (
        <EmptyState
          title="még nincs futó projekt"
          action={{ label: "Ugrás a dealekhez", href: "/deals" }}
        >
          Egy projekt egy megnyert dealből indul: a Dealek oldalon a Won oszlopban
          ott a „Projekt indítása”. A sablon mérföldkövei taskként jelennek meg —
          ugyanabban a Today Queue-ban, ugyanazzal a pipa-jelöléssel —, a
          teljesítésigazolás pedig a dokumentum-lánc végét zárja.
        </EmptyState>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">{rows(board.active)}</div>
      )}

      {board.closed.length > 0 && (
        <>
          <h2 className="mb-2 mt-7 font-display text-[17px] font-bold lowercase">lezárt</h2>
          <div className="grid gap-2.5 opacity-70 sm:grid-cols-2">{rows(board.closed)}</div>
        </>
      )}

      {open && (
        <Modal onClose={() => setOpen(null)} labelledBy="project-title">
          <div className="grid gap-3">
            <div>
              <h3 id="project-title" className="font-display text-[19px] font-extrabold lowercase">
                {open.name.toLowerCase()}
              </h3>
              {openTasks > 0 && (
                <span
                  data-testid="entity-header-task-badge"
                  title={`${openTasks} open task${openTasks === 1 ? "" : "s"}`}
                  className="ml-2 align-middle rounded-full border border-accent-soft px-2 py-0.5 text-[11px] tabular-nums text-accent-ink"
                >
                  ☑ {openTasks}
                </span>
              )}
              <p className="text-[12px] text-muted">
                {open.companyName ?? "—"} · {open.done}/{open.total} kész
                {open.closedAt && ` · lezárva ${when(open.closedAt)}`}
              </p>
            </div>

            <div className="grid gap-1.5">
              {open.milestones.map((m) => {
                const late = isOverdue(m.dueAt, m.doneAt);
                return (
                  <div
                    key={m.id}
                    data-testid="milestone-row"
                    className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={!!m.doneAt}
                      disabled={pending || !!open.closedAt}
                      data-testid={`milestone-check-${m.kind}`}
                      onChange={() => toggle(m.taskId, !!m.doneAt)}
                      className="h-4 w-4 shrink-0 accent-[#7427C6]"
                      aria-label={m.title}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[12.5px] ${
                          m.doneAt ? "text-muted line-through" : "text-ink"
                        }`}
                      >
                        {m.title}
                      </span>
                      <span className={`block text-[11px] ${late ? "text-warn" : "text-muted"}`}>
                        {m.dueAt ? when(m.dueAt) : "nincs határidő"}
                        {late && " · késésben"}
                      </span>
                    </span>

                    {/*
                      The chain, in one click. The certificate milestone is the
                      only one that opens a document — and it says why when it
                      cannot, rather than offering a button that does nothing.
                    */}
                    {m.kind === "certificate" && !m.doneAt && (
                      <span className="shrink-0">
                        {open.certificateDocumentId ? (
                          <Link
                            href={`/documents?doc=${open.certificateDocumentId}`}
                            className={BTN}
                            data-testid="milestone-certificate-open"
                          >
                            TIG megnyitása
                          </Link>
                        ) : open.contractId ? (
                          <Link
                            href={`/documents?contract=${open.contractId}&issue=certificate`}
                            className={BTN}
                            data-testid="milestone-certificate-issue"
                          >
                            TIG kiállítása
                          </Link>
                        ) : (
                          <span className="text-[11px] text-muted">aláírt szerződés kell hozzá</span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {!open.closedAt && (
              <div className="flex gap-1.5">
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="További mérföldkő…"
                  data-testid="milestone-new"
                  className="w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
                />
                <button onClick={add} disabled={pending || !newTitle.trim()} className={BTN}>
                  Hozzáadás
                </button>
              </div>
            )}

            {/**
             * Work that grew around the plan (playbook-v5 P20/4). The
             * milestones above are the template's checklist; this is
             * everything else anybody attached to the project, and the panel
             * deliberately leaves the milestones out so nothing appears twice.
             */}
            <EntityTasks kind="project" entityId={open.id} onCountChange={setOpenTasks} />

            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <Link href={`/deals?deal=${open.dealId}`} className={BTN}>
                Deal megnyitása
              </Link>
              {!open.closedAt && (
                <button
                  onClick={() => close(open.id)}
                  disabled={pending}
                  data-testid="project-close"
                  className={BTN}
                >
                  Projekt lezárása
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
