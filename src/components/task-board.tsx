"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { serverActionError } from "@/lib/client/server-action";
import {
  addAttachment,
  addComment,
  addDependency,
  addSubtask,
  archiveBoard,
  createBoard,
  createBoardTask,
  createSection,
  deleteSection,
  deleteTask,
  createBoardFromTemplate,
  deleteAttachment,
  dependencyCandidates,
  getBoard,
  getTaskDetail,
  listAttachments,
  listBoardTemplates,
  moveBoardTask,
  removeDependency,
  renameSection,
  setBoardTemplate,
  setRecurrence,
  setTaskDone,
  updateBoard,
  updateTask,
  myWork,
  type BoardTemplateSummary,
  type MyWorkItem,
  type TaskAttachmentView,
  type TaskDetailView,
  type WorkspaceMemberOption,
} from "@/modules/tasks/board-actions";
import type { BoardSummary, BoardView, TaskCardView } from "@/modules/tasks/board-store";
import {
  PRIORITY_CLASS,
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  describeRecurrence,
  priorityRank,
  readRecurrence,
  type TaskPriority,
} from "@/modules/tasks/board-logic";
import { MY_WORK_LIMIT } from "@/modules/tasks/attachment-rules";
import { TYPE_LABEL, type TaskType } from "@/modules/tasks/logic";
import { MAX_ATTACHMENT_BYTES } from "@/modules/tasks/attachment-rules";
import { Modal } from "./modal";
import { useToast } from "./toast";
import {
  InlineEdit,
  type InlineSaveResult,
  type InlineValue,
} from "./inline-edit";
import { editTaskField } from "@/modules/tasks/inline-actions";
import { useViewState } from "./use-view-state";
import { boolField, enumField, idField } from "@/lib/client/view-state";

/**
 * The task board (P8/1).
 *
 * ── WHY A BOARD AND NOT A LONGER LIST ───────────────────────────────────────
 *
 * Tasks already existed as one flat, workspace-wide list: a title, a due date,
 * an assignee, an optional link to a lead. That is enough to remember a
 * callback and not enough to RUN a piece of work — there was nowhere to say
 * what stage something is at, no way to group related work, no way to break one
 * task into its steps, and nowhere to write down the decision that changed it.
 *
 * Two arrangements of the same rows, because the two questions people ask are
 * different. The board answers "where is everything"; the list answers "what do
 * I do next", which is a sort, not a layout.
 */

const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";

function dueLabel(dueAt: Date | null): { text: string; overdue: boolean } {
  if (!dueAt) return { text: "", overdue: false };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(dueAt).getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "today", overdue: false };
  if (days === 1) return { text: "tomorrow", overdue: false };
  if (days < 7) return { text: `in ${days}d`, overdue: false };
  return { text: new Date(dueAt).toLocaleDateString("hu-HU"), overdue: false };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

// ---------------------------------------------------------------------------
// card
// ---------------------------------------------------------------------------

/**
 * What a task board's URL can say.
 *
 * Short keys, because people read and paste these: `/tasks?v=list&mine=1`.
 * `board` and `task` keep the names the notification links already use —
 * `notifyTaskAudience` has been sending `/tasks?board=X&task=Y` since task
 * assignment shipped, and renaming them would break every one already sent.
 */
const TASK_VIEW = {
  board: idField("board"),
  task: idField("task"),
  view: enumField("v", ["board", "list"] as const, "board"),
  mine: boolField("mine"),
  done: boolField("done"),
};

function Card({
  task,
  onOpen,
  onToggle,
  onDragStart,
  onEdit,
  onMove,
  dragging,
}: {
  task: TaskCardView;
  onOpen: () => void;
  onToggle: () => void;
  onDragStart: () => void;
  /** One field, committed to the server, which answers with what it stored. */
  onEdit: (field: string, value: InlineValue) => Promise<InlineSaveResult>;
  /** Keyboard movement. Arrow keys on the handle, one move per press. */
  onMove: (direction: "left" | "right" | "up" | "down") => void;
  dragging: boolean;
}) {
  const due = dueLabel(task.dueAt);
  const priority = (task.priority as TaskPriority) ?? "none";
  const dueDay = task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : null;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      data-testid="task-card"
      data-task-id={task.id}
      /**
       * Raised off the tray, not sunk into it. `bg-panel` at four percent is
       * invisible against a ten-percent tray, so a card carries its own
       * slightly deeper fill and a shadow — the only two things that say
       * "this is a movable object on a surface".
       */
      className={`group rounded-[11px] border border-line bg-[rgba(0,5,29,0.55)] p-3 shadow-[0_1px_3px_rgba(0,5,29,0.45)] transition-colors hover:border-accent ${
        dragging ? "opacity-40" : ""
      } ${task.doneAt ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={onToggle}
          aria-label={task.doneAt ? "Reopen" : "Complete"}
          data-testid="task-toggle"
          className={`mt-[1px] grid h-[17px] w-[17px] flex-none place-items-center rounded-full border text-[10px] ${
            task.doneAt
              ? "border-transparent bg-[rgba(61,220,151,0.2)] text-[#3DDC97]"
              : "border-line text-transparent hover:border-accent hover:text-muted"
          }`}
        >
          ✓
        </button>
        {/**
         * Single click OPENS, double click edits.
         *
         * The board's primary gesture is opening a card, and inline editing
         * must not take it: a title that turned into a text input on every
         * click would break the common action to serve the rarer one. The
         * tooltip says so, and Enter on the focused title still edits.
         *
         * The click handler sits on a PRESENTATIONAL div — no role, no
         * tabIndex. axe does not flag a bare div with onClick, which is
         * exactly why it is worth saying: the keyboard route in is the inline
         * control's own button (Enter edits) and the Open button beside it, so
         * nothing here depends on clicking a div. Giving this div role="button"
         * would nest it around the inline control and reproduce the
         * nested-interactive fault the pipeline card had.
         */}
        <div className="min-w-0 flex-1" onClick={onOpen} role="presentation">
          <InlineEdit
            kind="text"
            label="title"
            activateOn="doubleClick"
            value={task.title}
            display={
              <span
                className={`block text-[12.5px] leading-snug ${
                  task.doneAt ? "text-muted line-through" : "text-ink"
                }`}
              >
                {task.title}
              </span>
            }
            onSave={(next) => onEdit("title", next)}
          />
        </div>
        {task.assigneeName && (
          <span
            title={task.assigneeName}
            className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-grad text-[10px] font-bold"
          >
            {initials(task.assigneeName)}
          </span>
        )}

        {/**
         * THE KEYBOARD ROUTE ACROSS THE BOARD (playbook-v5 P16/4).
         *
         * Dragging was the only way to move a card, which means the board was
         * unusable without a pointer. This is the standard accessible
         * alternative: a named handle, arrow keys to move, one commit per
         * press — no "grab mode" to enter and remember, because a mode you can
         * be stuck in is its own accessibility problem. The move is announced
         * in the board's live region, since the card itself moving is the only
         * other feedback and a screen reader cannot see that.
         */}
        <button
          type="button"
          data-testid="card-move-handle"
          aria-label={`Move ${task.title}. Arrow keys move it between columns and positions.`}
          title="Arrow keys move this card"
          onKeyDown={(e) => {
            const map = {
              ArrowLeft: "left",
              ArrowRight: "right",
              ArrowUp: "up",
              ArrowDown: "down",
            } as const;
            const direction = map[e.key as keyof typeof map];
            if (!direction) return;
            e.preventDefault();
            e.stopPropagation();
            onMove(direction);
          }}
          className="mt-[1px] flex-none rounded-[4px] px-1 text-[11px] leading-none text-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent group-hover:opacity-100"
        >
          ⠿
        </button>
      </div>

      {(due.text || priority !== "none" || task.tags.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/**
           * These two ARE click-to-edit, unlike the title: a priority chip and
           * a date chip navigate nowhere, so a click on them has no other
           * meaning to protect.
           */}
          {priority !== "none" && (
            <span
              data-testid="card-priority"
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_CLASS[priority]}`}
            >
              <InlineEdit
                kind="select"
                label="priority"
                value={priority}
                options={TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
                display={PRIORITY_LABEL[priority]}
                onSave={(next) => onEdit("priority", next)}
              />
            </span>
          )}
          {due.text && (
            <span
              data-testid="task-due"
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                due.overdue ? "bg-[rgba(255,92,122,0.15)] text-[#FF5C7A]" : "bg-panel-2 text-muted"
              }`}
            >
              <InlineEdit
                kind="date"
                label="due date"
                value={dueDay}
                display={due.text}
                onSave={(next) => onEdit("dueAt", next)}
              />
            </span>
          )}
          {task.tags.map((t) => (
            <span key={t} className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-muted">
              {t}
            </span>
          ))}
        </div>
      )}

      {(task.subtasks || task.commentCount > 0 || task.entityLabel) && (
        <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[10.5px] text-muted">
          {task.subtasks && (
            <span data-testid="subtask-count">
              ☑ {task.subtasks.done}/{task.subtasks.total}
            </span>
          )}
          {task.commentCount > 0 && <span>💬 {task.commentCount}</span>}
          {task.entityLabel && task.entityHref && (
            <Link href={task.entityHref} className="truncate hover:text-ink">
              ↗ {task.entityLabel}
            </Link>
          )}
          {task.source && <span className="italic">auto</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

export function TaskBoards({
  boards,
  initialBoard,
  members,
  currentUserId,
  openTask = null,
}: {
  boards: BoardSummary[];
  initialBoard: BoardView | null;
  members: WorkspaceMemberOption[];
  currentUserId: string;
  /** A card to open on arrival, from `?task=` (P8/4). */
  openTask?: string | null;
}) {
  const router = useRouter();
  const { offerUndo } = useToast();
  const [board, setBoard] = useState<BoardView | null>(initialBoard);

  /**
   * The view lives in the URL (playbook-v5 P16/5).
   *
   * `board` and `task` were already query parameters — the page seeded them —
   * but they were copied into state on mount and never written back, so
   * switching board or opening a card changed nothing in the address bar. Which
   * meant a board could not be sent to anybody, a reload went back to the
   * first one, and Back did not close an open card: it left the page.
   *
   * `mine` and `done` were pure component state, so a filtered board was not a
   * thing you could link to at all.
   */
  const [viewState, setViewState] = useViewState(TASK_VIEW);
  const boardId = viewState.board ?? initialBoard?.id ?? null;
  const setBoardId = useCallback(
    (id: string | null) => setViewState({ board: id }),
    [setViewState],
  );
  const view = viewState.view;
  const setView = useCallback(
    (next: "board" | "list") => setViewState({ view: next }),
    [setViewState],
  );
  /**
   * "My work" is a third tab rather than a filter, because it is a different
   * question. The board answers "where is everything"; this answers "what do I
   * do next", across every board — which the dashboard panel cannot, since it
   * knows nothing about boards and so cannot say which piece of work a task
   * came from.
   */
  const [mine, setMine] = useState<MyWorkItem[] | null>(null);
  const [templates, setTemplates] = useState<BoardTemplateSummary[]>([]);
  const [fromTemplate, setFromTemplate] = useState(false);
  const mineOnly = viewState.mine;
  const setMineOnly = useCallback(
    (next: boolean) => setViewState({ mine: next }),
    [setViewState],
  );
  const showDone = viewState.done;
  const setShowDone = useCallback(
    (next: boolean) => setViewState({ done: next }),
    [setViewState],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The open card.
   *
   * Seeded from `?task=` so a deep link works. Only the initial value: after
   * that the URL is not the authority, or closing the drawer would fight the
   * query string and re-open it.
   */
  /**
   * The open card, in the URL, so Back closes it.
   *
   * NOT `viewState.task ?? openTask`, which is what this was and which reopened
   * the card the instant it was closed. `guard()` calls `router.refresh()`
   * after every write, and a refresh re-renders the server page against the
   * CURRENT url — so once the card had been opened, the `openTask` prop was no
   * longer null, and closing (which clears the parameter) fell straight back
   * to the prop. The URL said no card was open and the modal stayed up.
   *
   * The prop is only a first-paint seed for a deep link, and the hook reads
   * the same parameter itself, so there is nothing to fall back to.
   */
  const openTaskId = viewState.task;
  void openTask;
  const setOpenTaskId = useCallback(
    (id: string | null) => setViewState({ task: id }),
    [setViewState],
  );
  const [newBoardOpen, setNewBoardOpen] = useState(false);

  const dragged = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const refresh = useCallback(
    async (id = boardId) => {
      if (!id) {
        setBoard(null);
        return;
      }
      const next = await getBoard(id, {
        assigneeId: mineOnly ? currentUserId : null,
        includeDone: showDone,
      }).catch(() => null);
      setBoard(next);
    },
    [boardId, mineOnly, showDone, currentUserId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    listBoardTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  /** The board-settings dialog (name, description, colour, archive). */
  const [editingBoard, setEditingBoard] = useState(false);

  /**
   * One inline field, committed straight to the server.
   *
   * Deliberately NOT wrapped in `guard`: guard shows a page-level error banner
   * and refreshes the whole board, and an inline edit that did either would
   * undo the reason it exists. The cell puts the old value back itself and the
   * toast layer explains why. `refresh()` afterwards only on success, so a
   * card that now sorts differently ends up where it belongs.
   */
  const editField = useCallback(
    async (taskId: string, field: string, value: InlineValue): Promise<InlineSaveResult> => {
      const res = await editTaskField({ taskId, field, value });
      if (res.ok) void refresh();
      return res;
    },
    [refresh],
  );

  async function guard(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Drop handling.
   *
   * The card carries only its id; where it landed is decided from the DOM at
   * drop time and sent to the server as "this section, after that card". The
   * server owns the resulting rank — a browser computing its own sort keys is
   * how two clients end up disagreeing about the order.
   */
  function onDrop(sectionId: string | null, afterId: string | null) {
    const id = dragged.current;
    dragged.current = null;
    setDraggingId(null);
    if (!id) return;
    void guard(() => moveBoardTask({ id, sectionId, afterId }));
  }

  const columns = useMemo(() => {
    if (!board) return [];
    const cols = board.sections.map((s) => ({ id: s.id, name: s.name, tasks: s.tasks }));
    // Only shown when something is actually in it — an empty "No section"
    // column on every board is a column nobody asked for.
    if (board.unsectioned.length > 0) {
      cols.push({ id: "__none__", name: "No section", tasks: board.unsectioned });
    }
    return cols;
  }, [board]);

  /**
   * Move a card with the keyboard (playbook-v5 P16/4).
   *
   * Left and right cross columns and land at the TOP of the target, which is
   * both predictable and the position somebody moving work usually wants. Up
   * and down step within the column. Each press is one committed move, so
   * there is no mode to be stuck in — and `afterId` is the card that should
   * end up above it, which is what the store's ranking expects.
   */
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  /**
   * One move at a time.
   *
   * `columns` comes from the last refresh, so a second press that arrives
   * before the first has come back computes from stale positions — on a
   * three-column board that means the card moves to column two twice and the
   * keystroke is silently lost. Holding presses until the move lands costs a
   * beat and never lies about where the card went.
   */
  const moving = useRef(false);

  const moveByKeyboard = useCallback(
    async (taskId: string, direction: "left" | "right" | "up" | "down") => {
      if (moving.current) return;
      const ci = columns.findIndex((c) => c.tasks.some((t) => t.id === taskId));
      if (ci < 0) return;
      const column = columns[ci]!;
      const ti = column.tasks.findIndex((t) => t.id === taskId);

      if (direction === "left" || direction === "right") {
        const target = columns[ci + (direction === "left" ? -1 : 1)];
        if (!target) {
          setMoveAnnouncement(
            direction === "left" ? "Already in the first column." : "Already in the last column.",
          );
          return;
        }
        moving.current = true;
        try {
          await guard(() =>
            moveBoardTask({
              id: taskId,
              sectionId: target.id === "__none__" ? null : target.id,
              afterId: null,
            }),
          );
        } finally {
          moving.current = false;
        }
        setMoveAnnouncement(`Moved to ${target.name}, first position.`);
        return;
      }

      const to = ti + (direction === "up" ? -1 : 1);
      if (to < 0 || to >= column.tasks.length) {
        setMoveAnnouncement(
          direction === "up" ? "Already at the top." : "Already at the bottom.",
        );
        return;
      }
      const afterId =
        direction === "up" ? (column.tasks[to - 1]?.id ?? null) : column.tasks[to]!.id;
      moving.current = true;
      try {
        await guard(() =>
          moveBoardTask({
            id: taskId,
            sectionId: column.id === "__none__" ? null : column.id,
            afterId,
          }),
        );
      } finally {
        moving.current = false;
      }
      setMoveAnnouncement(
        `Moved to position ${to + 1} of ${column.tasks.length} in ${column.name}.`,
      );
    },
    // `guard` is stable enough for this: it closes over setters and refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns],
  );

  const listTasks = useMemo(() => {
    if (!board) return [];
    const all = [...board.sections.flatMap((s) => s.tasks), ...board.unsectioned];
    // The list answers "what next", so it sorts by urgency rather than
    // preserving the board's hand-arranged order.
    return all.sort((a, b) => {
      if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1;
      const pa = priorityRank(a.priority);
      const pb = priorityRank(b.priority);
      if (pa !== pb) return pa - pb;
      const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.title.localeCompare(b.title);
    });
  }, [board]);

  return (
    <div>
      {/* ---------- board switcher ---------- */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {boards.map((b) => (
          <button
            key={b.id}
            data-testid="board-tab"
            onClick={() => {
              setBoardId(b.id);
              setOpenTaskId(null);
            }}
            className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[12.5px] transition-colors ${
              b.id === boardId
                ? "border-accent bg-accent-soft text-ink"
                : "border-line bg-panel text-muted hover:text-ink"
            }`}
          >
            {b.color && (
              <span
                aria-hidden
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: b.color }}
              />
            )}
            {b.name}
            <span className="text-[10.5px] tabular-nums text-muted">
              {b.progress.done}/{b.progress.total}
            </span>
            {b.progress.overdue > 0 && (
              <span className="rounded-full bg-[rgba(255,92,122,0.15)] px-1.5 text-[10px] font-semibold text-[#FF5C7A]">
                {b.progress.overdue}
              </span>
            )}
          </button>
        ))}
        <button
          onClick={() => setNewBoardOpen(true)}
          data-testid="new-board"
          className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-ink"
        >
          + Board
        </button>
        {templates.length > 0 && (
          <button
            onClick={() => setFromTemplate(true)}
            data-testid="from-template"
            className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-ink"
          >
            + From template
          </button>
        )}
        <button
          onClick={async () => {
            if (mine) {
              setMine(null);
              return;
            }
            setMine(await myWork().catch(() => []));
          }}
          data-testid="my-work"
          className={`ml-auto rounded-[10px] border px-3 py-2 text-[12.5px] ${
            mine ? "border-accent bg-accent-soft text-ink" : "border-line bg-panel text-muted hover:text-ink"
          }`}
        >
          My work
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}

      {/* ---------- my work, across boards (P3/3.4) ---------- */}
      {mine && (
        <div className="mb-4 rounded-card border border-line bg-panel" data-testid="my-work-list">
          <div className="border-b border-line px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            My work · every board · {mine.length}
            {mine.length >= MY_WORK_LIMIT && (
              <>
                {" · "}
                <b className="text-warn">capped at {MY_WORK_LIMIT}</b>
              </>
            )}
          </div>
          {mine.length === 0 && (
            <p className="p-6 text-center text-[12.5px] text-muted">
              Nothing is assigned to you right now.
            </p>
          )}
          {mine.map((t) => {
            const due = dueLabel(t.dueAt);
            const priority = (t.priority as TaskPriority) ?? "none";
            return (
              <button
                key={t.id}
                onClick={() => {
                  if (t.boardId) setBoardId(t.boardId);
                  setOpenTaskId(t.id);
                }}
                data-testid="my-work-row"
                className="flex w-full items-center gap-2.5 border-b border-line px-3.5 py-2.5 text-left last:border-b-0 hover:bg-panel-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-ink">{t.title}</span>
                  <span className="block truncate text-[10.5px] text-muted">
                    {t.boardName ?? "no board"}
                    {t.sectionName ? ` · ${t.sectionName}` : ""}
                    {t.entityLabel ? ` · ${t.entityLabel}` : ""}
                  </span>
                </span>
                {/* A blocked task is not the next thing to pick up, and saying
                    so is the point of having dependencies at all. */}
                {t.blockedCount > 0 && (
                  <span
                    data-testid="my-work-blocked"
                    className="flex-none rounded-full bg-[rgba(245,184,65,0.15)] px-2 py-0.5 text-[10px] font-semibold text-warn"
                  >
                    waiting on {t.blockedCount}
                  </span>
                )}
                {priority !== "none" && (
                  <span
                    className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-semibold ${PRIORITY_CLASS[priority]}`}
                  >
                    {PRIORITY_LABEL[priority]}
                  </span>
                )}
                {due.text && (
                  <span
                    className={`w-[92px] flex-none text-right text-[11px] ${
                      due.overdue ? "text-[#FF5C7A]" : "text-muted"
                    }`}
                  >
                    {due.text}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {!board && (
        <div className="rounded-card border border-line bg-panel p-8 text-center">
          <p className="text-[13px] text-muted">
            {boards.length === 0
              ? "No boards yet. A board is a piece of work with columns — a launch, an onboarding, a quarter of outreach."
              : "Pick a board above."}
          </p>
          {boards.length === 0 && (
            <button
              onClick={() => setNewBoardOpen(true)}
              className="mt-3 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
            >
              Create the first board
            </button>
          )}
        </div>
      )}

      {board && (
        <>
          {/* ---------- board heading ---------- */}
          <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
            {/*
              The name is edited in place. A board people live in gets renamed
              — "Q4 launch" becomes "Q1 launch" — and sending them to a settings
              dialog for one field is a dialog nobody opens.
            */}
            <input
              value={board.name}
              onChange={(e) => setBoard({ ...board, name: e.target.value })}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== initialBoard?.name) {
                  void guard(() =>
                    updateBoard({
                      id: board.id,
                      name,
                      description: board.description ?? undefined,
                      color: board.color ?? undefined,
                    }),
                  );
                }
              }}
              data-testid="board-name"
              className="min-w-0 max-w-[380px] flex-1 rounded-[8px] border border-transparent bg-transparent px-1 py-0.5 font-display text-[20px] font-bold text-ink outline-none hover:border-line focus:border-accent"
            />
            {board.archivedAt && (
              <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                archived
              </span>
            )}
            {/*
              An explicit way in, next to the in-place name.

              Editing in place is right for the name and wrong as the ONLY
              route: a border that appears on hover is an affordance nobody
              finds, and the description and colour had no route at all — a
              board could be created with them and then never changed. This is
              the button somebody looks for when they want to rename a board.
            */}
            <button
              onClick={() => setEditingBoard(true)}
              data-testid="edit-board"
              title="Board name, description, colour and archiving"
              className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-ink"
            >
              Edit board
            </button>
          </div>

          {/* ---------- toolbar ---------- */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-[10px] border border-line bg-panel p-0.5">
              {(["board", "list"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  data-testid={`view-${v}`}
                  aria-pressed={view === v}
                  className={`rounded-[8px] px-3 py-1.5 text-[12px] capitalize ${
                    view === v ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>

            <button
              onClick={() => void guard(() => setBoardTemplate(board.id, true))}
              disabled={busy}
              title="Keep this board's sections and tasks as a reusable starting point. Its due dates become offsets."
              data-testid="save-as-template"
              className="rounded-[10px] border border-line bg-panel px-2.5 py-1.5 text-[12px] text-muted hover:text-ink disabled:opacity-60"
            >
              Save as template
            </button>

            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
                data-testid="filter-mine"
                style={{ accentColor: "#7427C6" }}
              />
              Only mine
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
                data-testid="filter-done"
                style={{ accentColor: "#7427C6" }}
              />
              Show completed
            </label>

            <div className="ml-auto flex items-center gap-2.5">
              <div className="h-1.5 w-[120px] overflow-hidden rounded-full bg-panel-2">
                <div
                  className="h-full bg-grad transition-[width]"
                  style={{ width: `${board.progress.pct}%` }}
                />
              </div>
              <span className="text-[11.5px] tabular-nums text-muted" data-testid="board-progress">
                {board.progress.pct}% · {board.progress.done}/{board.progress.total}
              </span>
              {/* Archiving moved into Board settings — one screen answers
                  "how do I change this board", rather than a bare link in the
                  progress row that reads like part of the metrics. */}
            </div>
          </div>

          {/**
           * Where a keyboard move is announced.
           *
           * The only other feedback is the card appearing somewhere else,
           * which a screen reader cannot see. One region for the board rather
           * than one per card, so moving three cards in a row does not
           * re-announce all of them.
           */}
          <div aria-live="polite" className="sr-only" data-testid="board-live">
            {moveAnnouncement}
          </div>

          {/* ---------- board view ---------- */}
          {view === "board" && (
            <div className="flex snap-x gap-3 overflow-x-auto pb-3">
              {columns.map((col) => (
                <Column
                  key={col.id}
                  boardId={board.id}
                  sectionId={col.id === "__none__" ? null : col.id}
                  name={col.name}
                  tasks={col.tasks}
                  busy={busy}
                  draggingId={draggingId}
                  onOpen={setOpenTaskId}
                  onToggle={async (t) => {
                    const res = await setTaskDone(t.id, !t.doneAt);
                    offerUndo(res.undo ?? null);
                    await refresh();
                  }}
                  onDragStart={(id) => {
                    dragged.current = id;
                    setDraggingId(id);
                  }}
                  onDrop={onDrop}
                  onEditField={editField}
                  onMoveByKeyboard={moveByKeyboard}
                  onAdd={(title) =>
                    guard(() =>
                      createBoardTask({
                        boardId: board.id,
                        sectionId: col.id === "__none__" ? null : col.id,
                        title,
                      }),
                    )
                  }
                  onRename={(name) => guard(() => renameSection(col.id, name))}
                  onDelete={() => guard(() => deleteSection(col.id))}
                  canEditSection={col.id !== "__none__"}
                />
              ))}

              <AddSection onAdd={(name) => guard(() => createSection({ boardId: board.id, name }))} />
            </div>
          )}

          {/* ---------- list view ---------- */}
          {view === "list" && (
            <div className="rounded-card border border-line bg-panel">
              {listTasks.length === 0 && (
                <p className="p-6 text-center text-[12.5px] text-muted">Nothing here yet.</p>
              )}
              {listTasks.map((t) => {
                const due = dueLabel(t.dueAt);
                const priority = (t.priority as TaskPriority) ?? "none";
                return (
                  <div
                    key={t.id}
                    data-testid="list-row"
                    className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 last:border-b-0"
                  >
                    <button
                      aria-label={t.doneAt ? `Reopen ${t.title}` : `Complete ${t.title}`}
                      onClick={async () => {
                        const res = await setTaskDone(t.id, !t.doneAt);
                        offerUndo(res.undo ?? null);
                        await refresh();
                      }}
                      className={`grid h-[17px] w-[17px] flex-none place-items-center rounded-full border text-[10px] ${
                        t.doneAt
                          ? "border-transparent bg-[rgba(61,220,151,0.2)] text-[#3DDC97]"
                          : "border-line text-transparent hover:border-accent"
                      }`}
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => setOpenTaskId(t.id)}
                      className={`min-w-0 flex-1 truncate text-left text-[12.5px] ${
                        t.doneAt ? "text-muted line-through" : "text-ink"
                      }`}
                    >
                      {t.title}
                    </button>
                    {priority !== "none" && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${PRIORITY_CLASS[priority]}`}
                      >
                        {PRIORITY_LABEL[priority]}
                      </span>
                    )}
                    {due.text && (
                      <span
                        className={`w-[92px] flex-none text-right text-[11px] ${
                          due.overdue ? "text-[#FF5C7A]" : "text-muted"
                        }`}
                      >
                        {due.text}
                      </span>
                    )}
                    <span className="w-[80px] flex-none truncate text-right text-[11px] text-muted">
                      {t.assigneeName ?? "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {openTaskId && (
        <TaskDetail
          taskId={openTaskId}
          members={members}
          onClose={() => setOpenTaskId(null)}
          onChanged={() => void refresh()}
        />
      )}

      {fromTemplate && (
        <FromTemplateDialog
          templates={templates}
          onClose={() => setFromTemplate(false)}
          onCreate={async (templateId, name) => {
            const res = await createBoardFromTemplate({ templateId, name });
            if (!res.ok) throw new Error(res.error);
            setFromTemplate(false);
            setBoardId(res.boardId);
            router.refresh();
          }}
        />
      )}

      {newBoardOpen && (
        <NewBoardDialog
          onClose={() => setNewBoardOpen(false)}
          onCreate={async (name, color) => {
            const { id } = await createBoard({ name, color });
            setNewBoardOpen(false);
            setBoardId(id);
            router.refresh();
          }}
        />
      )}

      {editingBoard && board && (
        <EditBoardDialog
          board={board}
          onClose={() => setEditingBoard(false)}
          onSave={async (patch) => {
            await guard(() => updateBoard({ id: board.id, ...patch }));
            setEditingBoard(false);
          }}
          onArchive={async (archived) => {
            await guard(async () => {
              // An archived board leaves the switcher, so the person who did
              // it by mistake cannot find it to put it back. The undo is the
              // way back.
              offerUndo((await archiveBoard(board.id, archived)).undo);
            });
            setEditingBoard(false);
            // An archived board leaves the switcher, so stop pointing at it.
            if (archived) setBoardId(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Board settings (name, description, colour, archiving).
 *
 * ── WHY A DIALOG WHEN THE NAME IS ALREADY EDITABLE IN PLACE ─────────────────
 *
 * In-place editing is right for the name and wrong as the only route. The
 * border only appears on hover, so nobody discovers it; and the description
 * and colour could be set when the board was CREATED and never changed
 * afterwards, which made them a decision you had to get right first time.
 *
 * Archiving lives here too rather than behind its own button: it is a
 * board-level setting, and putting it next to the name means the one screen
 * that answers "how do I change this board" answers all of it.
 */
function EditBoardDialog({
  board,
  onClose,
  onSave,
  onArchive,
}: {
  board: {
    name: string;
    description: string | null;
    color: string | null;
    archivedAt: Date | string | null;
  };
  onClose: () => void;
  onSave: (patch: { name: string; description?: string; color?: string }) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description ?? "");
  const [color, setColor] = useState(board.color ?? "#7427C6");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = board.archivedAt !== null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="mb-3 font-display text-lg font-bold lowercase">board settings</h3>
      {error && (
        <p role="alert" data-testid="edit-board-error" className="mb-2 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      <label className="grid gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Name
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="edit-board-name"
          className={INPUT}
        />
      </label>

      <label className="mt-2.5 grid gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Description
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What this board is for. Shown in the switcher."
          data-testid="edit-board-description"
          className={`${INPUT} resize-y`}
        />
      </label>

      <label className="mt-2.5 flex items-center gap-2 text-[12px] text-muted">
        Colour
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          data-testid="edit-board-color"
          className="h-8 w-12 rounded border border-line bg-transparent"
        />
        <span className="text-[11.5px]">The chip beside the board&apos;s name.</span>
      </label>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {/*
          Archive, not delete. A board holds work that happened, and removing
          it would take the tasks with it — "we did that in the old board" is a
          sentence people need to be able to finish.
        */}
        <button
          onClick={() => void run(() => onArchive(!archived))}
          disabled={busy}
          data-testid="edit-board-archive"
          className="mr-auto text-[12px] text-muted underline decoration-dotted hover:text-ink disabled:opacity-60"
        >
          {archived ? "Bring it back" : "Archive this board"}
        </button>
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          disabled={!name.trim() || busy}
          data-testid="edit-board-save"
          onClick={() =>
            void run(() =>
              onSave({
                name: name.trim(),
                description: description.trim() || undefined,
                color,
              }),
            )
          }
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// column
// ---------------------------------------------------------------------------

function Column({
  sectionId,
  name,
  tasks,
  busy,
  draggingId,
  onOpen,
  onToggle,
  onDragStart,
  onDrop,
  onAdd,
  onRename,
  onDelete,
  onEditField,
  onMoveByKeyboard,
  canEditSection,
}: {
  boardId: string;
  sectionId: string | null;
  name: string;
  tasks: TaskCardView[];
  busy: boolean;
  draggingId: string | null;
  onOpen: (id: string) => void;
  onToggle: (t: TaskCardView) => Promise<void>;
  onDragStart: (id: string) => void;
  onDrop: (sectionId: string | null, afterId: string | null) => void;
  onAdd: (title: string) => Promise<unknown>;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onEditField: (
    taskId: string,
    field: string,
    value: InlineValue,
  ) => Promise<InlineSaveResult>;
  onMoveByKeyboard: (
    taskId: string,
    direction: "left" | "right" | "up" | "down",
  ) => Promise<void>;
  canEditSection: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [over, setOver] = useState(false);

  return (
    <div
      data-testid="board-column"
      data-section-id={sectionId ?? "none"}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        // Dropped on the column background = the end of the column.
        onDrop(sectionId, tasks[tasks.length - 1]?.id ?? null);
      }}
      /**
       * The tray is LIGHTER than the cards on it.
       *
       * It used to be `bg-panel-2/40` — a white tint knocked down to under
       * three percent, which on this canvas read as a muddy grey and, worse,
       * came out DARKER than the `bg-panel` cards sitting on it. That is
       * backwards from every board anybody has used: the column is a tray and
       * the cards are raised off it, so the tray has to be the brighter
       * surface. Same white as every other token here (#EFF1F8), just more of
       * it.
       */
      className={`w-[280px] flex-none snap-start rounded-card border p-2.5 transition-colors ${
        over
          ? "border-accent bg-accent-soft/30"
          : "border-line bg-[rgba(239,241,248,0.10)]"
      }`}
    >
      <div className="mb-2 flex items-center gap-1.5 px-1">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (draft.trim() && draft !== name) void onRename(draft.trim());
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="min-w-0 flex-1 rounded-[6px] border border-accent bg-[rgba(0,5,29,0.5)] px-1.5 py-1 text-[11.5px] font-semibold text-ink outline-none"
          />
        ) : (
          <button
            onClick={() => canEditSection && setRenaming(true)}
            className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted hover:text-ink"
          >
            {name}
          </button>
        )}
        <span className="text-[11px] tabular-nums text-muted">{tasks.length}</span>
        {canEditSection && (
          <button
            onClick={() => void onDelete()}
            title="Delete the column. Its tasks move to No section — they are never deleted with it."
            className="ml-auto text-[13px] leading-none text-muted hover:text-[#FFB3C2]"
          >
            ×
          </button>
        )}
      </div>

      <div className="grid gap-2">
        {tasks.map((t) => (
          <div
            key={t.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDrop(sectionId, t.id);
            }}
          >
            <Card
              task={t}
              dragging={draggingId === t.id}
              onOpen={() => onOpen(t.id)}
              onToggle={() => void onToggle(t)}
              onDragStart={() => onDragStart(t.id)}
              onEdit={(field, value) => onEditField(t.id, field, value)}
              onMove={(direction) => void onMoveByKeyboard(t.id, direction)}
            />
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            data-testid="new-task-input"
            onKeyDown={async (e) => {
              if (e.key === "Escape") {
                setAdding(false);
                setTitle("");
              }
              if (e.key === "Enter" && title.trim()) {
                await onAdd(title.trim());
                setTitle("");
                // Stays open: adding tasks is something people do in runs.
              }
            }}
            onBlur={() => !title.trim() && setAdding(false)}
            className={INPUT}
          />
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={busy}
          data-testid="add-task"
          className="mt-2 w-full rounded-[9px] border border-dashed border-line px-2.5 py-2 text-left text-[12px] text-muted hover:border-accent hover:text-ink disabled:opacity-60"
        >
          + Add task
        </button>
      )}
    </div>
  );
}

function AddSection({ onAdd }: { onAdd: (name: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="w-[240px] flex-none">
      {open ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Column name"
          data-testid="new-section-input"
          onKeyDown={async (e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && name.trim()) {
              await onAdd(name.trim());
              setName("");
              setOpen(false);
            }
          }}
          onBlur={() => setOpen(false)}
          className={INPUT}
        />
      ) : (
        <button
          onClick={() => setOpen(true)}
          data-testid="add-section"
          className="w-full rounded-card border border-dashed border-line px-3 py-2.5 text-left text-[12.5px] text-muted hover:border-accent hover:text-ink"
        >
          + Add column
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

function TaskDetail({
  taskId,
  members,
  onClose,
  onChanged,
}: {
  taskId: string;
  members: WorkspaceMemberOption[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [task, setTask] = useState<TaskDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [subtask, setSubtask] = useState("");
  const [saving, setSaving] = useState(false);
  /** Subtask ticks shown before the server has confirmed them. */
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  /** Other tasks on this board, to depend on. */
  const [candidates, setCandidates] = useState<
    Array<{ id: string; title: string; doneAt: Date | null }>
  >([]);

  const load = useCallback(async () => {
    setTask(await getTaskDetail(taskId).catch(() => null));
  }, [taskId]);

  useEffect(() => {
    void load();
    dependencyCandidates(taskId)
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [load, taskId]);

  async function save(patch: Record<string, unknown>) {
    await run(() => updateTask({ id: taskId, ...patch }));
  }

  /**
   * Every write in this panel goes through here.
   *
   * ── TWO FAILURE MODES, BOTH SEEN IN PRACTICE ──────────────────────────────
   *
   * Four writes used to `await` a server action and throw the result away, so a
   * subtask that failed to delete looked exactly like one that worked.
   *
   * Then this helper caught THROWN errors and ignored RETURNED ones — and the
   * newer actions (dependencies, attachments, recurrence) report refusals as
   * `{ ok: false, error }` rather than by throwing. So "that would make a loop"
   * and "that file type is not accepted" were computed, returned, and silently
   * dropped: the dialog just did nothing. Both shapes are handled now, because
   * an action's contract is not something a caller should have to remember.
   */
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setSaving(true);
    setError(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "ok" in res && res.ok === false) {
        const message = "error" in res && typeof res.error === "string" ? res.error : null;
        setError(message ?? "That did not work.");
        // Still reload: the server refused, so the panel must show what is
        // actually stored rather than the state the click implied.
        await load();
        return;
      }
      await load();
      onChanged();
      after?.();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setSaving(false);
    }
  }

  if (!task) {
    return (
      <Modal onClose={onClose}>
        <p className="text-[12.5px] text-muted">Loading…</p>
      </Modal>
    );
  }

  const iso = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-start gap-2">
        <input
          value={task.title}
          onChange={(e) => setTask({ ...task, title: e.target.value })}
          onBlur={(e) => e.target.value.trim() && void save({ title: e.target.value.trim() })}
          data-testid="detail-title"
          className="min-w-0 flex-1 rounded-[8px] border border-transparent bg-transparent px-1 py-1 font-display text-[19px] font-bold text-ink outline-none hover:border-line focus:border-accent"
        />
        <button aria-label="Close" onClick={onClose} className="text-muted hover:text-ink">
          ✕
        </button>
      </div>

      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}
      {task.source && (
        <p className="mb-2 rounded-[8px] border border-accent-soft bg-accent-soft px-2.5 py-1.5 text-[11.5px] text-accent-ink">
          Raised automatically · {task.source}
        </p>
      )}

      <div className="mb-3 grid gap-2.5 sm:grid-cols-2">
        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Assignee
          <select
            value={task.assigneeId ?? ""}
            onChange={(e) => void save({ assigneeId: e.target.value || null })}
            data-testid="detail-assignee"
            className={`${INPUT} mt-1`}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Priority
          <select
            value={task.priority}
            onChange={(e) => void save({ priority: e.target.value })}
            data-testid="detail-priority"
            className={`${INPUT} mt-1`}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Start
          <input
            type="date"
            value={iso(task.startAt)}
            onChange={(e) => void save({ startAt: e.target.value || null })}
            className={`${INPUT} mt-1`}
          />
        </label>

        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Due
          <input
            type="date"
            value={iso(task.dueAt)}
            onChange={(e) => void save({ dueAt: e.target.value || null })}
            data-testid="detail-due"
            className={`${INPUT} mt-1`}
          />
        </label>

        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Type
          <select
            value={task.type}
            onChange={(e) => void save({ type: e.target.value })}
            className={`${INPUT} mt-1`}
          >
            {(Object.keys(TYPE_LABEL) as TaskType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Tags · comma separated
          <input
            defaultValue={task.tags.join(", ")}
            onBlur={(e) =>
              void save({
                tags: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .slice(0, 12),
              })
            }
            className={`${INPUT} mt-1`}
          />
        </label>
      </div>

      <label className="mb-3 block text-[11px] uppercase tracking-[0.1em] text-muted">
        Description
        <textarea
          defaultValue={task.note ?? ""}
          onBlur={(e) => void save({ note: e.target.value })}
          rows={3}
          data-testid="detail-note"
          className={`${INPUT} mt-1 resize-y`}
        />
      </label>

      {/* ---------- subtasks ---------- */}
      <div className="mb-3">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Subtasks {task.subtasks.length > 0 && `· ${task.subtasks.filter((s) => s.doneAt).length}/${task.subtasks.length}`}
        </div>
        {task.subtasks.map((s) => (
          <label
            key={s.id}
            data-testid="subtask-row"
            className="flex items-center gap-2 py-1 text-[12.5px] text-[#C9CEE3]"
          >
            {/*
              Ticked here first, then on the server.

              A controlled checkbox whose state only moves after a round trip
              reads as broken: you click, nothing happens for 300ms, and you
              click again. The optimistic value is reconciled by `load()` — and
              rolled back by it if the write failed, because the reload returns
              what the database actually holds rather than what we hoped.
            */}
            <input
              type="checkbox"
              checked={optimistic[s.id] ?? !!s.doneAt}
              onChange={async (e) => {
                const next = e.target.checked;
                setOptimistic((o) => ({ ...o, [s.id]: next }));
                await run(() => setTaskDone(s.id, next));
                setOptimistic((o) => {
                  const { [s.id]: _drop, ...rest } = o;
                  return rest;
                });
              }}
              style={{ accentColor: "#7427C6" }}
            />
            <span className={(optimistic[s.id] ?? !!s.doneAt) ? "text-muted line-through" : ""}>
              {s.title}
            </span>
            <button
              aria-label={`Delete subtask ${s.title}`}
              onClick={() => void run(() => deleteTask(s.id))}
              className="ml-auto text-[12px] text-muted hover:text-[#FFB3C2]"
            >
              ×
            </button>
          </label>
        ))}
        <input
          value={subtask}
          onChange={(e) => setSubtask(e.target.value)}
          placeholder="+ Add a step"
          data-testid="subtask-input"
          onKeyDown={(e) => {
            if (e.key === "Enter" && subtask.trim()) {
              const title = subtask.trim();
              setSubtask("");
              void run(() => addSubtask(taskId, title));
            }
          }}
          className={`${INPUT} mt-1.5`}
        />
        {/* Stated because it is a real decision, not an omission. */}
        <p className="mt-1 text-[10.5px] text-muted">
          Completing this task does not complete its steps, and finishing every
          step does not close this task.
        </p>
      </div>

      {/* ---------- dependencies (P3/3.1) ---------- */}
      <div className="mb-3">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Waiting for
        </div>
        {task.blockedBy.map((b) => (
          <div
            key={b.id}
            data-testid="dependency-row"
            className="flex items-center gap-2 py-1 text-[12.5px]"
          >
            <span className={b.doneAt ? "text-muted line-through" : "text-warn"}>
              {b.doneAt ? "✓" : "⏳"} {b.title}
            </span>
            <button
              aria-label={`Remove the dependency on ${b.title}`}
              onClick={() => void run(() => removeDependency({ taskId, blockedById: b.id }))}
              className="ml-auto text-[12px] text-muted hover:text-[#FFB3C2]"
            >
              ×
            </button>
          </div>
        ))}

        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            void run(() => addDependency({ taskId, blockedById: e.target.value }));
          }}
          data-testid="dependency-add"
          className={`${INPUT} mt-1`}
        >
          <option value="">+ Wait for another task on this board…</option>
          {candidates
            .filter((c) => !task.blockedBy.some((b) => b.id === c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
                {c.doneAt ? " (done)" : ""}
              </option>
            ))}
        </select>

        {task.blocking.length > 0 && (
          <p className="mt-1 text-[10.5px] text-muted">
            {task.blocking.length} task{task.blocking.length === 1 ? "" : "s"} waiting on this one:{" "}
            {task.blocking.map((b) => b.title).join(", ")}
          </p>
        )}
        {/* Stated, because it is a decision rather than an omission. */}
        <p className="mt-1 text-[10.5px] text-muted">
          Shown, not enforced — a blocked task can still be ticked. A graph drawn
          wrong should not be a board on which nothing can move.
        </p>
      </div>

      {/* ---------- recurrence (P3/3.2) ---------- */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Repeat
          <select
            value={task.recurrence?.cadence ?? ""}
            onChange={(e) =>
              void run(() =>
                setRecurrence({
                  taskId,
                  recurrence: e.target.value
                    ? {
                        cadence: e.target.value as "daily" | "weekly" | "monthly",
                        dayOfWeek: task.recurrence?.dayOfWeek ?? 1,
                        dayOfMonth: task.recurrence?.dayOfMonth ?? 1,
                      }
                    : null,
                }),
              )
            }
            data-testid="detail-recurrence"
            className={`${INPUT} mt-1`}
          >
            <option value="">Happens once</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </select>
        </label>
        {task.recurrence && (
          <p className="self-end text-[11px] leading-relaxed text-muted">
            {describeRecurrence(task.recurrence as never)}. The next one is created
            when you tick this — so the board holds one at a time rather than a
            queue of future copies.
          </p>
        )}
      </div>

      {/* ---------- attachments (P3/3.5) ---------- */}
      <div className="mb-3">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Files
        </div>
        {task.attachments.map((a) => (
          <div
            key={a.id}
            data-testid="attachment-row"
            className="flex items-center gap-2 py-1 text-[12.5px]"
          >
            <a
              href={`/api/files/${a.path}`}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-[#C9CEE3] underline hover:text-ink"
            >
              {a.filename}
            </a>
            <span className="flex-none text-[10.5px] tabular-nums text-muted">
              {Math.max(1, Math.round(a.sizeBytes / 1024))} KB
            </span>
            <button
              aria-label={`Remove ${a.filename}`}
              onClick={() => void run(() => deleteAttachment(a.id))}
              className="text-[12px] text-muted hover:text-[#FFB3C2]"
            >
              ×
            </button>
          </div>
        ))}
        <input
          type="file"
          data-testid="attachment-input"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > MAX_ATTACHMENT_BYTES) {
              setError(
                `That file is ${Math.round(file.size / 1_000_000)} MB; the limit is ${
                  MAX_ATTACHMENT_BYTES / 1_000_000
                } MB.`,
              );
              return;
            }
            // Base64 through the server action rather than a signed upload URL:
            // the files volume is local to this deployment, and 15 MB is well
            // inside what one request can carry.
            const buf = await file.arrayBuffer();
            let binary = "";
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            await run(() =>
              addAttachment({
                taskId,
                filename: file.name,
                contentType: file.type || "application/octet-stream",
                base64: btoa(binary),
              }),
            );
          }}
          className="mt-1 w-full text-[11.5px] text-muted file:mr-2 file:rounded-[8px] file:border file:border-line file:bg-panel file:px-2.5 file:py-1.5 file:text-[11.5px] file:text-ink"
        />
      </div>

      {/* ---------- comments ---------- */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Comments
        </div>
        {task.comments.map((c) => (
          <div key={c.id} data-testid="comment-row" className="mb-2">
            <div className="flex items-baseline gap-2">
              <b className="text-[12px]">{c.userName}</b>
              <span className="text-[10.5px] text-muted">
                {new Date(c.createdAt).toLocaleString("hu-HU")}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[#C9CEE3]">
              {c.body}
            </p>
          </div>
        ))}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Write a comment. Type @ and a name to bring somebody in."
          data-testid="comment-input"
          className={`${INPUT} mt-1 resize-y`}
        />
        <button
          disabled={!comment.trim() || saving}
          onClick={() => {
            const body = comment.trim();
            void run(
              () => addComment({ taskId, body }),
              () => setComment(""),
            );
          }}
          data-testid="comment-submit"
          className="mt-1.5 rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60"
        >
          Comment
        </button>
      </div>

      <div className="mt-4 flex justify-between border-t border-line pt-3">
        <button
          onClick={() => void run(() => deleteTask(taskId), onClose)}
          data-testid="detail-delete"
          className="text-[12px] text-muted hover:text-[#FFB3C2]"
        >
          Delete task
        </button>
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

function NewBoardDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, color: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7427C6");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal onClose={onClose}>
      <h3 className="mb-3 font-display text-lg font-bold lowercase">new board</h3>
      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Board name"
        data-testid="board-name-input"
        className={INPUT}
      />
      <label className="mt-2.5 flex items-center gap-2 text-[12px] text-muted">
        Colour
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-8 w-12 rounded border border-line bg-transparent"
        />
      </label>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted">
        It opens with To do / In progress / Done. Rename or add columns any time.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          disabled={!name.trim() || busy}
          data-testid="board-create"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onCreate(name.trim(), color);
            } catch (e) {
              setError(serverActionError(e));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          Create
        </button>
      </div>
    </Modal>
  );
}


/**
 * A new board from a saved template (P3/3.3).
 *
 * Assignees and comments deliberately do NOT come across. An onboarding
 * template that arrives pre-assigned to whoever happened to build it is a
 * board somebody has to un-assign first, and a comment from a previous
 * engagement is somebody else's conversation.
 */
function FromTemplateDialog({
  templates,
  onClose,
  onCreate,
}: {
  templates: BoardTemplateSummary[];
  onClose: () => void;
  onCreate: (templateId: string, name: string) => Promise<void>;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = templates.find((t) => t.id === templateId);

  return (
    <Modal onClose={onClose}>
      <h3 className="mb-3 font-display text-lg font-bold lowercase">new board from a template</h3>
      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

      <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
        Template
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          data-testid="template-select"
          className={`${INPUT} mt-1`}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.sections} columns, {t.tasks} tasks
            </option>
          ))}
        </select>
      </label>

      {chosen?.description && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{chosen.description}</p>
      )}

      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name for the new board"
        data-testid="template-board-name"
        className={`${INPUT} mt-2.5`}
      />
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
        Columns, tasks, notes and priorities come across. Due dates are recreated
        from the template&apos;s offsets — &ldquo;three days after we start&rdquo;.
        Assignees and comments do not: work should not arrive pre-assigned to
        whoever built the template.
      </p>

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          disabled={!name.trim() || !templateId || busy}
          data-testid="template-create"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onCreate(templateId, name.trim());
            } catch (e) {
              setError(serverActionError(e));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          Create
        </button>
      </div>
    </Modal>
  );
}
