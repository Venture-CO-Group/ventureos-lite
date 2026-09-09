import {
  Skeleton,
  SkeletonBoard,
  SkeletonHeader,
  SkeletonPanel,
  SkeletonRows,
  SkeletonText,
} from "./skeleton";

/**
 * One skeleton per surface (playbook-v5 P16/2).
 *
 * Each mirrors the real component's outer structure closely enough that the
 * swap does not move anything: same header block, same panel, same column
 * count, same row height. They live together rather than beside their pages so
 * the family can be compared at a glance — a skeleton that has drifted from
 * its surface is the failure mode here, and drift is easier to see in a list.
 */

export function LeadsTableSkeleton() {
  return (
    <>
      <SkeletonHeader />
      {/* The saved-view tab strip. */}
      <div className="mb-3 flex gap-1.5">
        {["72px", "88px", "64px"].map((w) => (
          <Skeleton key={w} w={w} h={30} className="rounded-[10px]" />
        ))}
      </div>
      <SkeletonPanel>
        <div className="mb-3 flex items-center gap-2">
          <Skeleton w="240px" h={30} className="rounded-[10px]" />
          <Skeleton w="110px" h={30} className="rounded-[10px]" />
        </div>
        {/**
         * Twenty rows, not eight. The real table pages at DEFAULT_PAGE_SIZE
         * (50) and fills the viewport several times over; an eight-row
         * placeholder measured 416px against 1135px of content, which the
         * height check in e2e/skeletons.spec.ts caught. Twenty is the point
         * past which more rows are below the fold anyway.
         */}
        <SkeletonRows rows={20} cols={6} />
      </SkeletonPanel>
    </>
  );
}

export function PipelineBoardSkeleton() {
  return (
    <>
      <SkeletonHeader />
      {/* Six stages, the pipeline's real width. */}
      <SkeletonBoard columns={6} perColumn={[3, 2, 4, 2, 1, 2]} />
    </>
  );
}

export function DealsBoardSkeleton() {
  return (
    <>
      <SkeletonHeader />
      <div className="mb-3 flex gap-1.5">
        {["96px", "84px"].map((w) => (
          <Skeleton key={w} w={w} h={32} className="rounded-[10px]" />
        ))}
      </div>
      <SkeletonBoard columns={5} perColumn={[2, 3, 2, 1, 2]} />
    </>
  );
}

export function TaskBoardSkeleton() {
  return (
    <>
      <SkeletonHeader />
      <div className="mb-3 flex gap-1.5">
        {["104px", "92px", "76px"].map((w) => (
          <Skeleton key={w} w={w} h={30} className="rounded-[10px]" />
        ))}
      </div>
      <SkeletonBoard columns={4} perColumn={[3, 2, 4, 1]} />
    </>
  );
}

/**
 * The inbox is three columns and the middle one is the list, so its skeleton
 * has to keep all three — a single-column placeholder would reflow the whole
 * screen when the real thing arrived.
 */
export function InboxSkeleton() {
  return (
    <>
      <SkeletonHeader withAction={false} />
      <div className="grid gap-3 lg:grid-cols-[260px_1fr_300px]">
        <SkeletonPanel>
          <div className="grid gap-2.5">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="grid gap-1.5 border-b border-line pb-2.5">
                <Skeleton w="72%" h={11} />
                <Skeleton w="46%" h={9} />
              </div>
            ))}
          </div>
        </SkeletonPanel>
        <SkeletonPanel>
          <Skeleton w="55%" h={14} />
          <div className="mt-3">
            <SkeletonText lines={5} />
          </div>
        </SkeletonPanel>
        <SkeletonPanel className="hidden lg:block">
          <SkeletonText lines={4} />
        </SkeletonPanel>
      </div>
    </>
  );
}

export function ProspectorSkeleton() {
  return (
    <>
      <SkeletonHeader />
      <SkeletonPanel className="mb-3">
        <div className="flex flex-wrap gap-2">
          <Skeleton w="220px" h={32} className="rounded-[10px]" />
          <Skeleton w="160px" h={32} className="rounded-[10px]" />
          <Skeleton w="120px" h={32} className="rounded-[10px]" />
        </div>
      </SkeletonPanel>
      {/**
       * NO result cards.
       *
       * The prospector opens with a search box and nothing else — results
       * exist only after somebody runs a search, which costs a Places call.
       * Six placeholder cards made the skeleton TALLER than the surface it
       * stands in for, and the height check caught it. A skeleton promises
       * what is coming, and on this page what is coming is a form.
       */}
      <SkeletonPanel>
        <SkeletonText lines={2} />
      </SkeletonPanel>
    </>
  );
}

export function AnalyticsSkeleton() {
  return (
    <>
      <SkeletonHeader />
      <div className="mb-3 flex gap-1.5">
        {["82px", "76px", "96px"].map((w) => (
          <Skeleton key={w} w={w} h={30} className="rounded-[10px]" />
        ))}
      </div>
      {/**
       * The real page is NINE panels, not six: a funnel and a stage table, a
       * two-column row below them, and a three-card grid at the bottom. A
       * four-stat-and-two-chart placeholder measured 398px against 1133px, and
       * the height check in e2e/skeletons.spec.ts caught it. This mirrors the
       * three real rows instead of guessing.
       */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr]">
        <SkeletonPanel>
          <Skeleton w="42%" h={11} />
          <div className="mt-3">
            <Skeleton h={220} />
          </div>
        </SkeletonPanel>
        <SkeletonPanel>
          <Skeleton w="48%" h={11} />
          <div className="mt-3">
            <SkeletonRows rows={6} cols={4} />
          </div>
        </SkeletonPanel>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <SkeletonPanel>
          <Skeleton w="38%" h={11} />
          <div className="mt-3">
            <Skeleton h={180} />
          </div>
        </SkeletonPanel>
        <SkeletonPanel>
          <Skeleton w="52%" h={11} />
          <div className="mt-3">
            <SkeletonText lines={6} />
          </div>
        </SkeletonPanel>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonPanel key={i}>
            <Skeleton w="56%" h={10} />
            <div className="mt-2.5">
              <SkeletonText lines={3} />
            </div>
          </SkeletonPanel>
        ))}
      </div>
    </>
  );
}

/**
 * The audit's deterministic checks.
 *
 * NOT a page skeleton: /audit awaits nothing server-side, and the runner
 * already streams its checks in as they finish — which the playbook is right
 * to say is better than a placeholder. This replaces the "Running
 * deterministic checks…" LINE that stood where the two-column check grid
 * arrives, so the panel does not grow by ten rows in one frame.
 */
export function AuditChecksSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-x-[18px] gap-y-1.5 sm:grid-cols-2">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 py-1.5">
          <Skeleton w="14px" h={14} className="rounded-full" />
          <Skeleton w={i % 3 === 0 ? "72%" : "58%"} h={10} />
        </div>
      ))}
    </div>
  );
}

export function ContentHubSkeleton() {
  return (
    <>
      <SkeletonHeader />
      <SkeletonBoard columns={5} perColumn={[2, 1, 3, 1, 2]} />
    </>
  );
}
