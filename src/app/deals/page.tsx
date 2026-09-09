import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { DealsBoardSkeleton } from "@/components/skeletons";
import { DealsBoard } from "@/components/deals-board";
import { getDealsBoard } from "@/modules/deals/actions";

export const dynamic = "force-dynamic";

/**
 * The deals board (playbook-v2 P4/b).
 *
 * One pipeline at a time, chosen by the `pipeline` query parameter, so a board
 * is a place with a URL rather than a client-side toggle.
 */
export default function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; per?: string }>;
}) {
  return (
    <AppShell activePath="/deals">
      <Suspense fallback={<DealsBoardSkeleton />}>
        <DealsBody searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

async function DealsBody({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; per?: string }>;
}) {
  const { pipeline, per } = await searchParams;
  const board = await getDealsBoard(pipeline, Number(per) || undefined);

  return (
    <>
      {board.pipelines.length === 0 ? (
        <div className="rounded-card border border-line bg-panel p-8 text-center">
          <h2 className="font-display text-[22px] lowercase tracking-display">no pipelines yet</h2>
          <p className="mx-auto mt-2 max-w-[420px] text-[13px] text-muted">
            A pipeline is where a qualified lead becomes money you can forecast.
          </p>
        </div>
      ) : (
        <DealsBoard
          pipelines={board.pipelines}
          activePipelineId={board.activePipelineId}
          cards={board.cards}
          totals={board.totals}
          shown={board.shown}
          pageSize={board.pageSize}
        />
      )}
    </>
  );
}
