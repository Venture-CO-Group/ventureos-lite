import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { TaskBoardSkeleton } from "@/components/skeletons";
import { TaskBoards } from "@/components/task-board";
import {
  getAssignableMembers,
  getBoard,
  getBoards,
} from "@/modules/tasks/board-actions";
import { getActiveContext } from "@/lib/session";

/**
 * Tasks (P8/1).
 *
 * The dashboard already had a task panel — a flat list of what is due. This is
 * the other half: where the work is arranged, broken into steps, assigned and
 * argued about. The panel keeps answering "what do I do next"; this answers
 * "where is everything".
 *
 * The first board is rendered on the server so the page has something on it
 * before any client fetch; the switcher takes over from there.
 */
export const dynamic = "force-dynamic";

export default function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; task?: string }>;
}) {
  return (
    <AppShell activePath="/tasks">
      <Suspense fallback={<TaskBoardSkeleton />}>
        <TasksBody searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

async function TasksBody({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; task?: string }>;
}) {
  const params = await searchParams;
  const { userId } = await getActiveContext();
  const [boards, members] = await Promise.all([getBoards(), getAssignableMembers()]);

  // The board named in the URL, otherwise the first one. A stale id in a
  // bookmark falls back rather than rendering an empty screen.
  const requested = params.board && boards.some((b) => b.id === params.board)
    ? params.board
    : (boards[0]?.id ?? null);
  const initialBoard = requested ? await getBoard(requested) : null;

  return (
    <>
      <div className="mb-4">
        <h1 className="font-display text-[28px] font-extrabold lowercase tracking-display">
          tasks
        </h1>
        <p className="text-[12.5px] text-muted">
          Boards for work that has steps. Follow-ups raised from a lead stay on
          the dashboard and on the lead — they do not need a board to exist.
        </p>
      </div>

      <TaskBoards
        boards={boards}
        initialBoard={initialBoard}
        members={members}
        currentUserId={userId}
        /**
         * Open a specific card (P8/4).
         *
         * `?task=` was already the link the notification system produced —
         * `notifyTaskAudience` has been sending `/tasks?board=X&task=Y` since
         * task assignment shipped — and the page ignored it, so every "somebody
         * put a task on you" notification landed on a board and left the person
         * to find the card. The dashboard now produces the same link, and it
         * works.
         */
        openTask={params.task ?? null}
      />
    </>
  );
}
