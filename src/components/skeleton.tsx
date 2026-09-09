/**
 * Loading shapes (playbook-v5 P16/2).
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A surface whose layout is KNOWN shows that layout, never a spinner. The
 * difference is not decoration: a spinner says "wait", a skeleton says "a
 * table with eight rows and six columns is arriving", and only the second one
 * stops the page jumping when it does. Which is why these are composed from
 * the same tokens and spacing as the real thing — a skeleton that is roughly
 * the right shape is a layout shift with extra steps.
 *
 * ── AND WHY THERE IS NO isLoading PROP ──────────────────────────────────────
 *
 * These render inside a `<Suspense fallback>`. React decides when they are on
 * screen, so they never need to know.
 */

export function Skeleton({
  className = "",
  w,
  h = 12,
}: {
  className?: string;
  /** Any CSS width. A percentage keeps a text line honest at every breakpoint. */
  w?: string;
  h?: number;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="skeleton"
      className={`skeleton block ${className}`}
      style={{ width: w, height: h }}
    />
  );
}

/**
 * Lines of "text". Widths vary because real prose does — a stack of identical
 * bars reads as a graphic, not as a paragraph waiting to load.
 */
export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  const widths = ["92%", "78%", "85%", "64%", "88%"];
  return (
    <span className={`grid gap-1.5 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={widths[i % widths.length]} h={10} />
      ))}
    </span>
  );
}

/** The panel every surface here is built out of. */
export function SkeletonPanel({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-card border border-line bg-panel p-[18px] ${className}`}>
      {children}
    </div>
  );
}

/**
 * A page's title block.
 *
 * Present on every surface, and always the same shape, so it is the one piece
 * that genuinely cannot shift.
 */
export function SkeletonHeader({ withAction = true }: { withAction?: boolean }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="grid gap-2">
        <Skeleton w="220px" h={24} />
        <Skeleton w="320px" h={11} />
      </div>
      {withAction && <Skeleton w="130px" h={34} className="rounded-[10px]" />}
    </div>
  );
}

/** Rows of a table, at the row height the real table uses. */
export function SkeletonRows({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="grid gap-px">
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="grid items-center gap-3 border-b border-line py-2.5"
          style={{ gridTemplateColumns: `1.6fr ${"1fr ".repeat(Math.max(0, cols - 1)).trim()}` }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} w={c === 0 ? "70%" : "48%"} h={11} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One kanban card. */
export function SkeletonCard() {
  return (
    <div className="rounded-[11px] border border-line bg-[rgba(0,5,29,0.55)] p-3">
      <Skeleton w="82%" h={12} />
      <div className="mt-2 flex gap-1.5">
        <Skeleton w="54px" h={16} className="rounded-full" />
        <Skeleton w="42px" h={16} className="rounded-full" />
      </div>
    </div>
  );
}

/**
 * A board of columns.
 *
 * `perColumn` varies the card count so the columns are not suspiciously equal —
 * and so the tallest column sets a height close to what the real board needs.
 */
export function SkeletonBoard({
  columns = 4,
  perColumn = [3, 2, 4, 2],
}: {
  columns?: number;
  perColumn?: number[];
}) {
  return (
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: columns }, (_, i) => (
        <div
          key={i}
          className="min-w-[248px] flex-1 rounded-card border border-line bg-panel-2 p-2.5"
        >
          <div className="mb-2.5 flex items-center justify-between px-1.5">
            <Skeleton w="88px" h={11} />
            <Skeleton w="18px" h={11} />
          </div>
          <div className="grid gap-2.5">
            {Array.from({ length: perColumn[i % perColumn.length] ?? 3 }, (_, c) => (
              <SkeletonCard key={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
