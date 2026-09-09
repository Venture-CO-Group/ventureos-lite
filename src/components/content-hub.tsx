"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createPost,
  deletePost,
  draftPostWithClaude,
  movePost,
  addVariant,
  deleteVariant,
  updatePost,
  type ContentBoardView,
  type ContentPostView,
} from "@/modules/content/actions";
import {
  CHANNELS,
  CONTENT_STATUSES,
  STATUS_LABEL,
  allowedTransitions,
  maxCharsFor,
  type ContentStatus,
} from "@/modules/content/board";
import { Modal } from "./modal";
import { useViewState } from "./use-view-state";
import { BulkBar, type BulkAction } from "./bulk-bar";
import { StateCard } from "./state-card";
import { useBulkSelection } from "./use-bulk-selection";
import { bulkContentStatus } from "@/modules/content/bulk-actions";
import { idField } from "@/lib/client/view-state";

const CARD = "rounded-card border border-line bg-panel p-3";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-glow transition-opacity disabled:opacity-45 disabled:shadow-none";
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

const COLUMN_HINT: Record<ContentStatus, string> = {
  DRAFT: "Being written",
  IN_REVIEW: "Waiting on an Owner or Admin",
  APPROVED: "Ready to post",
  PUBLISHED: "Live — recorded by hand",
};

/**
 * How far the pointer may travel between press and release and still count as
 * a click. Same value and reasoning as the pipeline board: without it, the
 * drift of starting a drag opens the editor on top of the drag you wanted.
 */
const DRAG_THRESHOLD_PX = 5;

/** `?post=` is the open editor. */
const CONTENT_VIEW = { post: idField("post") };

export function ContentHub({ board }: { board: ContentBoardView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /**
   * The open post, in the URL (playbook-v5 P16/5): Back closes the editor
   * rather than leaving the board, and a draft under review can be linked to.
   */
  const [view, setView] = useViewState(CONTENT_VIEW);
  const openId = view.post;
  const setOpenId = useCallback(
    (id: string | null) => setView({ post: id }),
    [setView],
  );
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  /**
   * Bulk status changes (playbook-v5 P17/1).
   *
   * The phase rule holds per post — an illegal jump is refused for one card
   * and must be refused for forty — so the skips name where each post actually
   * is rather than reporting a bare count.
   */
  const selection = useBulkSelection(board.posts.length);
  const bulkActions = useMemo<BulkAction<unknown>[]>(
    () => [
      {
        key: "status",
        label: "Move to phase",
        noun: "post",
        verb: "moved",
        initial: "IN_REVIEW" as unknown,
        form: (state, set) => (
          <select
            aria-label="Phase"
            data-testid="bulk-status-value"
            value={String(state ?? "IN_REVIEW")}
            onChange={(e) => set(e.target.value)}
            className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none"
          >
            {CONTENT_STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        ),
        run: (ids, state) => bulkContentStatus(ids, String(state ?? "IN_REVIEW")),
      },
    ],
    [],
  );

  /** Shared by the header button and the empty Draft column. */
  const newPost = useCallback(() => {
    startTransition(async () => {
      const res = await createPost({ channel: "linkedin" });
      if (res.ok) {
        setOpenId(res.id);
        router.refresh();
      } else {
        setMsg({ kind: "err", text: res.error });
      }
    });
  }, [router, setOpenId]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<ContentStatus | null>(null);
  /**
   * Optimistic placement while the server decides. A refused move clears it and
   * the card snaps back to where it came from — the board never shows a state
   * the server did not agree to.
   */
  const [optimistic, setOptimistic] = useState<{ id: string; to: ContentStatus } | null>(null);
  const draggedRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);

  const byStatus = useMemo(() => {
    const map = new Map<ContentStatus, ContentPostView[]>();
    for (const s of CONTENT_STATUSES) map.set(s, []);
    for (const p of board.posts) {
      const status = optimistic?.id === p.id ? optimistic.to : p.status;
      map.get(status)?.push(p);
    }
    return map;
  }, [board.posts, optimistic]);

  function moveTo(post: ContentPostView, to: ContentStatus) {
    if (post.status === to) return;
    setMsg(null);
    setMoveMenuFor(null);
    setOptimistic({ id: post.id, to });
    startTransition(async () => {
      const res = await movePost({ id: post.id, to });
      if (!res.ok) {
        // Snap back, and say why — a card silently returning is a mystery.
        setOptimistic(null);
        setMsg({ kind: "err", text: res.error });
        return;
      }
      // Deliberately do NOT clear the optimistic placement here. router.refresh
      // is async, so clearing now drops the card back into its old column until
      // the new data arrives — a visible flash backwards after a move that
      // actually succeeded. The effect below clears it once the server agrees.
      router.refresh();
    });
  }

  // Retire the optimistic placement only when the refreshed board reports the
  // same status, so there is no window where the card sits in the old column.
  useEffect(() => {
    if (!optimistic) return;
    const post = board.posts.find((p) => p.id === optimistic.id);
    if (post && post.status === optimistic.to) setOptimistic(null);
  }, [board.posts, optimistic]);

  const open = board.posts.find((p) => p.id === openId) ?? null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setMsg({ kind: "err", text: res.error ?? "That did not work." });
      else if (okText) setMsg({ kind: "ok", text: okText });
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold lowercase tracking-display">
            content hub
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Company-page posts. Claude drafts in a locked brand voice; a human
            approves and posts.
          </p>
        </div>
        <button
          type="button"
          className={BTN_PRIMARY}
          data-testid="content-new"
          disabled={pending}
          onClick={newPost}
        >
          + New post
        </button>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="content-message"
          className={`rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      <BulkBar
        selection={selection}
        actions={bulkActions}
        onDone={() => router.refresh()}
      />

      {/* Swipeable columns on a phone, four across on desktop. */}
      <div
        className="grid snap-x snap-mandatory auto-cols-[82vw] grid-flow-col items-start gap-3 overflow-x-auto pb-3 nav:auto-cols-fr nav:grid-flow-row nav:grid-cols-4 nav:overflow-visible"
        data-testid="content-board"
        data-pending={pending}
      >
        {CONTENT_STATUSES.map((status) => {
          const posts = byStatus.get(status) ?? [];
          return (
            <section
              key={status}
              data-testid={`content-col-${status}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                // One move at a time. A second drop while the first is still
                // in flight is judged by the server against the OLD status and
                // refused, which looks to the user like the board rejecting a
                // legal move.
                if (pending) return;
                const post = board.posts.find((c) => c.id === dragId);
                if (post) moveTo(post, status);
              }}
              className={`min-h-[160px] snap-start rounded-card border bg-panel p-2.5 ${
                dragOver === status
                  ? "border-accent shadow-[0_0_20px_rgba(116,39,198,0.3)_inset]"
                  : "border-line"
              }`}
            >
              <header className="flex items-baseline gap-2 px-1 pb-2.5">
                <h3 className="text-[12.5px] font-semibold text-ink">{STATUS_LABEL[status]}</h3>
                <span className="text-[11px] text-muted tabular-nums">{posts.length}</span>
              </header>
              <p className="px-1 pb-2 text-[10.5px] uppercase tracking-[0.1em] text-muted">
                {COLUMN_HINT[status]}
              </p>

              {posts.length === 0 && (
                /**
                 * "Nothing here." was a status line, not a state. A column of
                 * a kanban board is the one place a bare line is nearly
                 * defensible — but it still has to say what would put
                 * something in it, and the first column is where the action
                 * belongs.
                 */
                <StateCard
                  mode="empty"
                  inset
                  title={status === "DRAFT" ? "nothing drafted" : "nothing here"}
                  testId={`content-empty-${status}`}
                  action={
                    status === "DRAFT" ? { label: "Write a post", onClick: newPost } : null
                  }
                >
                  {status === "DRAFT"
                    ? "A topic starts here and moves right as it is written, reviewed and approved."
                    : `Posts arrive here from ${COLUMN_HINT[status] || "the column to the left"}.`}
                </StateCard>
              )}

              {posts.map((p) => (
                /**
                 * NOT role="button" — the same fault axe found on the pipeline
                 * card (P16/4). It contains a Move-to control, and now a
                 * selection box, so announcing the whole card as one button
                 * puts three controls inside it and makes the card a single
                 * opaque tab stop. /content is not one of the six screens the
                 * axe gate visits, which is exactly why it was still here. The
                 * keyboard route in is the title button below.
                 */
                <div
                  key={p.id}
                  draggable
                  data-testid="content-card"
                  onDragStart={() => {
                    draggedRef.current = true;
                    setDragId(p.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onPointerDown={(e) => {
                    pressRef.current = { x: e.clientX, y: e.clientY };
                    draggedRef.current = false;
                  }}
                  onClick={(e) => {
                    // The Move to… control handles itself.
                    if ((e.target as HTMLElement).closest("button")) return;
                    if (draggedRef.current) return;
                    const start = pressRef.current;
                    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD_PX) {
                      return;
                    }
                    setOpenId(p.id);
                  }}
                  className={`group mb-2 w-full cursor-pointer rounded-[11px] border bg-panel-2 p-2.5 text-left transition-shadow hover:border-accent-soft hover:shadow-[0_0_16px_rgba(116,39,198,0.25)] focus-within:border-accent ${
                    dragId === p.id ? "border-accent opacity-60" : "border-line"
                  }`}
                >
                  <span className="mb-1 flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={selection.isSelected(p.id)}
                      onChange={() => selection.toggle(p.id)}
                      onClick={(e) => e.stopPropagation()}
                      data-testid="content-select"
                      aria-label={`Select ${p.title}`}
                      style={{ accentColor: "#7427C6" }}
                      className={`flex-none transition-opacity ${
                        selection.isSelected(p.id)
                          ? "opacity-100"
                          : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      }`}
                    />
                    <span className="inline-block rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-muted">
                      {STATUS_LABEL[p.status]}
                    </span>
                  </span>
                  <b className="block text-[13px] text-ink">
                    <button
                      type="button"
                      onClick={() => setOpenId(p.id)}
                      className="w-full rounded-[4px] text-left focus-visible:ring-1 focus-visible:ring-accent"
                    >
                      {p.title}
                    </button>
                  </b>
                  {/* No `block` here: line-clamp needs display:-webkit-box, and `block`
                      overrides it — which is why the excerpt was never actually
                      clamped. */}
                  <span className="mt-0.5 line-clamp-2 text-[11.5px] text-muted">
                    {p.variants.find((v) => v.body.trim())?.body || "No text yet."}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted">
                    {/*
                      One chip per channel this topic has been written for. The
                      card IS the topic now, so three renderings of one subject
                      are three chips here rather than three cards on the board.
                    */}
                    {p.variants.length === 0 ? (
                      <span className="rounded-[5px] border border-dashed border-line px-1.5 py-px">
                        no channel yet
                      </span>
                    ) : (
                      p.variants.map((v) => (
                        <span
                          key={v.id}
                          data-testid={`content-card-channel-${v.channel}`}
                          className={`rounded-[5px] border px-1.5 py-px ${
                            v.body.trim() ? "border-line" : "border-dashed border-line text-muted"
                          }`}
                          title={v.body.trim() ? undefined : "Nothing written yet"}
                        >
                          {CHANNELS.find((c) => c.key === v.channel)?.label ?? v.channel}
                        </span>
                      ))
                    )}
                    {p.hasUneditedDraft ? (
                      <span className="text-warn">✦ unedited draft</span>
                    ) : (
                      p.variants.some((v) => v.aiDrafted) && <span className="text-pos">✦ edited</span>
                    )}
                    {p.anyOverLimit && <span className="text-neg">over limit</span>}
                    {p.publishedAt && <span>{p.publishedAt.slice(0, 10)}</span>}
                  </span>

                  {/*
                    Touch fallback: dragging between columns is awkward on a
                    phone, where the columns are a swipeable carousel and a
                    horizontal drag means "scroll".
                  */}
                  <div className="mt-2 nav:hidden">
                    {moveMenuFor === p.id ? (
                      <div className="flex flex-wrap gap-1.5">
                        {allowedTransitions(p.status, board.isApprover).map((tr) => (
                          <button
                            key={tr.to}
                            type="button"
                            data-testid={`move-to-${tr.to}`}
                            onClick={() => moveTo(p, tr.to)}
                            className="min-h-[36px] rounded-full border border-accent-soft px-3 text-[11.5px] font-semibold text-accent-ink"
                          >
                            {tr.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => setMoveMenuFor(null)}
                          className="min-h-[36px] rounded-full border border-line px-3 text-[11.5px] text-muted"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid="move-to-open"
                        onClick={() => setMoveMenuFor(p.id)}
                        className="min-h-[36px] rounded-full border border-line px-3 text-[11.5px] text-muted"
                      >
                        Move to…
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>

      {open && (
        <PostEditor
          post={open}
          isApprover={board.isApprover}
          pending={pending}
          onClose={() => setOpenId(null)}
          onRun={run}
        />
      )}
    </div>
  );
}

function PostEditor({
  post,
  isApprover,
  pending,
  onClose,
  onRun,
}: {
  post: ContentPostView;
  isApprover: boolean;
  pending: boolean;
  onClose: () => void;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) => void;
}) {
  const [title, setTitle] = useState(post.title);
  /**
   * The channel being edited, and one body per channel.
   *
   * A map rather than a single string so switching tabs does not throw away an
   * unsaved edit — the operator writing a newsletter version should be able to
   * glance at the LinkedIn one and come back to their text.
   */
  const [activeId, setActiveId] = useState<string | null>(post.variants[0]?.id ?? null);
  const [bodies, setBodies] = useState<Record<string, string>>(() =>
    Object.fromEntries(post.variants.map((v) => [v.id, v.body])),
  );
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [rationale, setRationale] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const active = post.variants.find((v) => v.id === activeId) ?? null;
  const body = active ? (bodies[active.id] ?? "") : "";
  const max = active ? maxCharsFor(active.channel) : null;
  const over = max !== null && body.length > max;
  const locked = post.status === "PUBLISHED";
  const transitions = allowedTransitions(post.status, isApprover);
  const missing = CHANNELS.filter((c) => !post.variants.some((v) => v.channel === c.key));

  /** Persist the title and the channel currently on screen. */
  const saveCurrent = () =>
    updatePost({
      id: post.id,
      title,
      ...(active ? { variant: { id: active.id, body } } : {}),
    });

  async function draft() {
    setError(null);
    setDrafting(true);
    try {
      const res = await draftPostWithClaude({
        id: post.id,
        // Claude drafts ONE channel's version: the channel decides the shape of
        // the text, not just its length.
        variantId: active?.id,
        topic,
        notes,
        language: "HU",
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (!title.trim() || title === "Untitled post") setTitle(res.title);
      if (active) setBodies((b) => ({ ...b, [active.id]: res.body }));
      setRationale(res.rationale || null);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="content-editor-title" wide>
      <div className="mb-3 flex items-center gap-2">
        <h3 id="content-editor-title" className="font-display text-lg font-bold lowercase">
          {STATUS_LABEL[post.status].toLowerCase()}
        </h3>
        {post.authorName && (
          <span className="text-[11.5px] text-muted">by {post.authorName}</span>
        )}
        {post.approvedByName && (
          <span className="text-[11.5px] text-muted">· approved by {post.approvedByName}</span>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      {error && (
        <p
          role="alert"
          data-testid="content-editor-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}

      {locked && (
        <p className="mb-3 rounded-[8px] border border-line px-3 py-2 text-[12px] text-muted">
          Published{post.publishedAt ? ` on ${post.publishedAt.slice(0, 10)}` : ""}. Reopen it to
          make changes.
          {post.variants
            .filter((v) => v.publishedUrl)
            .map((v) => (
              <span key={v.id}>
                {" "}
                <a
                  href={v.publishedUrl!}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-ink underline-offset-2 hover:underline"
                >
                  View {CHANNELS.find((c) => c.key === v.channel)?.label ?? v.channel}
                </a>
              </span>
            ))}
        </p>
      )}

      {/* ---------- Claude draft ---------- */}
      {!locked && (
        <div className="mb-3 rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Draft with Claude · brand voice is fixed
          </p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is the post about?"
              data-testid="content-topic"
              className={INPUT}
            />
            <button
              type="button"
              className={BTN_PRIMARY}
              data-testid="content-draft"
              disabled={drafting || topic.trim().length < 3}
              onClick={draft}
            >
              {drafting ? "Drafting…" : "✦ Draft"}
            </button>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Facts to include (optional) — no invented numbers"
              className={`${INPUT} sm:col-span-2`}
            />
          </div>
          {rationale && (
            <p className="mt-2 text-[12px] text-muted">
              <b className="text-ink">Angle:</b> {rationale}
            </p>
          )}
        </div>
      )}

      {/* ---------- editor ---------- */}
      <div className="grid gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={locked}
          placeholder="Internal title"
          data-testid="content-title"
          className={INPUT}
        />
        {/*
          ONE CARD, ONE TOPIC, A TAB PER CHANNEL.

          This used to be a channel <select> on a single body, which meant the
          same subject as a LinkedIn post AND a blog article AND a newsletter was
          three separate cards moving through review separately. Now the topic is
          the card and each channel is a tab inside it; adding one is a button,
          not a new card.
        */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
          {post.variants.map((v) => (
            <button
              key={v.id}
              type="button"
              data-testid={`content-tab-${v.channel}`}
              onClick={() => setActiveId(v.id)}
              className={`rounded-[8px] border px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                v.id === activeId
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-line text-muted hover:border-accent-soft hover:text-ink"
              }`}
            >
              {CHANNELS.find((c) => c.key === v.channel)?.label ?? v.channel}
              {!(bodies[v.id] ?? "").trim() && <span className="ml-1 text-muted">·</span>}
            </button>
          ))}
          {!locked &&
            missing.map((c) => (
              <button
                key={c.key}
                type="button"
                data-testid={`content-add-${c.key}`}
                disabled={pending}
                title={`Write a ${c.label} version of this topic`}
                onClick={() =>
                  onRun(async () => {
                    // Save what is on screen first, so adding a channel cannot
                    // cost the operator the paragraph they just wrote.
                    if (active) {
                      const saved = await saveCurrent();
                      if (!saved.ok) return saved;
                    }
                    const res = await addVariant({ postId: post.id, channel: c.key });
                    if (res.ok) setActiveId(res.id);
                    return res;
                  }, `${c.label} version added.`)
                }
                className="rounded-[8px] border border-dashed border-line px-2.5 py-1.5 text-[12px] text-muted hover:border-accent hover:text-ink disabled:opacity-45"
              >
                + {c.label}
              </button>
            ))}
        </div>

        {active ? (
          <textarea
            value={body}
            onChange={(e) => setBodies((b) => ({ ...b, [active.id]: e.target.value }))}
            disabled={locked}
            rows={12}
            placeholder={`The ${CHANNELS.find((c) => c.key === active.channel)?.label ?? active.channel} version…`}
            data-testid="content-body"
            className={`${INPUT} resize-y leading-relaxed`}
          />
        ) : (
          <p className="rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-muted">
            No channel yet. Add LinkedIn, a blog version or a newsletter above.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          {max !== null && (
            <span className={over ? "font-semibold text-neg tabular-nums" : "text-muted tabular-nums"}>
              {body.length} / {max}
            </span>
          )}
          {active?.aiDrafted && (
            <span className={active.humanEdited ? "text-pos" : "text-warn"}>
              {active.humanEdited ? "edited by a human" : "still Claude's words"}
            </span>
          )}
          {active?.publishedUrl && (
            <a
              href={active.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent-ink underline-offset-2 hover:underline"
            >
              posted here ↗
            </a>
          )}
          {!locked && active && post.variants.length > 1 && (
            <button
              type="button"
              data-testid="content-remove-variant"
              disabled={pending}
              className="ml-auto text-[11.5px] text-muted hover:text-[#FFB3C2] disabled:opacity-45"
              onClick={() =>
                onRun(async () => {
                  const res = await deleteVariant({ id: active.id });
                  if (res.ok) {
                    setActiveId(post.variants.find((v) => v.id !== active.id)?.id ?? null);
                  }
                  return res;
                }, "Channel removed.")
              }
            >
              Remove this channel
            </button>
          )}
        </div>
      </div>

      {/* ---------- actions ---------- */}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={BTN}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(body);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setError("Could not copy — select the text and copy it manually.");
            }
          }}
          disabled={!body.trim()}
        >
          {copied ? "Copied ✓" : "Copy text"}
        </button>

        {!locked && (
          <button
            type="button"
            className={BTN}
            data-testid="content-save"
            disabled={pending}
            onClick={() => onRun(saveCurrent, "Saved.")}
          >
            Save
          </button>
        )}

        {transitions.map((t) => (
          <button
            key={t.to}
            type="button"
            className={t.to === "APPROVED" || t.to === "PUBLISHED" ? BTN_PRIMARY : BTN}
            data-testid={`content-move-${t.to}`}
            disabled={pending}
            onClick={() =>
              onRun(async () => {
                // Persist edits first, so the gate judges what is on screen.
                if (!locked) {
                  const saved = await saveCurrent();
                  if (!saved.ok) return saved;
                }
                const res = await movePost({ id: post.id, to: t.to });
                if (res.ok) onClose();
                return res;
              }, `${t.label}.`)
            }
          >
            {t.label}
          </button>
        ))}

        <button
          type="button"
          className={BTN}
          data-testid="content-delete"
          disabled={pending}
          onClick={() =>
            onRun(async () => {
              const res = await deletePost({ id: post.id });
              if (res.ok) onClose();
              return res;
            }, "Deleted.")
          }
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
