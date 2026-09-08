"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchWorkspace } from "@/modules/search/actions";
import { MIN_QUERY_LENGTH, type SearchHit } from "@/modules/search/query";
import {
  GOTO_MAP,
  PALETTE_ACTIONS,
  RECENTS_STORAGE_KEY,
  matchActions,
  pushRecent,
  readRecents,
  type PaletteAction,
  type RecentItem,
} from "@/modules/search/palette";
import { useAppActions } from "./app-actions";
import { isHrefHidden } from "@/modules/workspaces/nav-visibility";

/**
 * The ⌘K command palette and the keyboard map (playbook-v2 P7/3).
 *
 * Built ON the P3/1 search API rather than beside it: entity results come from
 * the same `searchWorkspace` the top bar uses, so a lead found by a typo in the
 * palette is found by the same rules — one search, two surfaces.
 *
 * EVERY SHORTCUT IS SUPPRESSED INSIDE AN INPUT. That is not a detail: without
 * it, typing "n" in a notes field opens the new-lead dialog, and the person
 * loses what they were writing. The one exception is ⌘K itself, which is the
 * standard escape hatch and cannot collide with typing.
 */

const DEBOUNCE_MS = 180;

interface Row {
  key: string;
  label: string;
  hint?: string;
  detail?: string;
  group: string;
  run: () => void;
}

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    node.isContentEditable === true
  );
}

export function CommandPalette({ hiddenNav = [] }: { hiddenNav?: string[] }) {
  const router = useRouter();
  /**
   * Rows for screens this workspace has switched off.
   *
   * A palette that still jumps to a menu item somebody deliberately removed is
   * a menu item that was not removed. Decluttering only — the route itself is
   * untouched, so a link from a notification still works.
   */
  const hidden = useMemo(() => new Set(hiddenNav), [hiddenNav]);
  const visible = useCallback(
    <T extends { href?: string }>(a: T) => !isHrefHidden(a.href, hidden),
    [hidden],
  );
  const { openDialog } = useAppActions();
  const [open, setOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  /** The `g` prefix, armed for a moment after the key is pressed. */
  const gotoArmed = useRef(false);
  const gotoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rememberRecent = useCallback((item: Omit<RecentItem, "atMs">) => {
    setRecents((current) => {
      const next = pushRecent(current, { ...item, atMs: Date.now() });
      try {
        window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private browsing, a full quota — a convenience list is not worth throwing over */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      setRecents(readRecents(window.localStorage.getItem(RECENTS_STORAGE_KEY)));
    } catch {
      setRecents([]);
    }
  }, []);

  // ---- global keys ---------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘K / Ctrl-K works everywhere, including inside an input: it is the
      // standard way out of wherever you are.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        setShowShortcuts(false);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (open) return;

      // g + letter navigation.
      if (gotoArmed.current) {
        const href = GOTO_MAP[e.key.toLowerCase()];
        gotoArmed.current = false;
        if (gotoTimer.current) clearTimeout(gotoTimer.current);
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (e.key.toLowerCase() === "g") {
        gotoArmed.current = true;
        // A prefix that never expires turns the NEXT keystroke of the day into
        // a navigation. One second is long enough to be deliberate.
        gotoTimer.current = setTimeout(() => {
          gotoArmed.current = false;
        }, 1000);
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        openDialog("new-lead");
      } else if (e.key === "t") {
        e.preventDefault();
        openDialog("new-task");
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openDialog, router]);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setActive(0);
      // A frame, so the dialog exists before the focus lands on it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ---- entity search -------------------------------------------------------
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_QUERY_LENGTH) {
      setHits([]);
      return;
    }
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const results = await searchWorkspace({ q: term }).catch(() => []);
      if (id !== requestId.current) return;
      setHits(results);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const rows: Row[] = useMemo(() => {
    const runAction = (action: PaletteAction) => () => {
      setOpen(false);
      if (action.id === "new-lead") return openDialog("new-lead");
      if (action.id === "import") return openDialog("csv-import");
      if (action.id === "new-task") return openDialog("new-task");
      if (action.id === "shortcuts") return setShowShortcuts(true);
      if (action.href) router.push(action.href);
    };

    if (q.trim().length === 0) {
      const recentRows: Row[] = recents.map((r) => ({
        key: `recent:${r.href}`,
        label: r.title,
        detail: r.subtitle,
        group: "Recent",
        run: () => {
          setOpen(false);
          router.push(r.href);
        },
      }));
      const actionRows: Row[] = PALETTE_ACTIONS.filter(
        (a) => a.group === "action" && visible(a),
      ).map((a) => ({
        key: a.id,
        label: a.label,
        hint: a.hint,
        group: "Actions",
        run: runAction(a),
      }));
      return [...recentRows, ...actionRows];
    }

    const actionRows: Row[] = matchActions(q).filter(visible).map((a) => ({
      key: a.id,
      label: a.label,
      hint: a.hint,
      group: a.group === "action" ? "Actions" : "Go to",
      run: runAction(a),
    }));

    const hitRows: Row[] = hits.map((h) => ({
      key: `${h.kind}:${h.id}`,
      label: h.title,
      detail: h.subtitle,
      group: h.kind === "lead" ? "Leads" : h.kind === "company" ? "Companies" : "Documents",
      run: () => {
        setOpen(false);
        rememberRecent({
          kind: h.kind,
          id: h.id,
          title: h.title,
          subtitle: h.subtitle,
          href: h.href,
        });
        router.push(h.href);
      },
    }));

    // Entities first when there are any: someone typing a person's name wants
    // the person, not the verb that happens to share a letter with it.
    return [...hitRows, ...actionRows];
  }, [q, hits, recents, router, openDialog, rememberRecent]);

  useEffect(() => setActive(0), [q]);

  if (showShortcuts) {
    return <ShortcutOverlay hidden={hidden} onClose={() => setShowShortcuts(false)} />;
  }
  if (!open) return null;

  const grouped: Array<[string, Row[]]> = [];
  for (const row of rows) {
    const last = grouped[grouped.length - 1];
    if (last && last[0] === row.group) last[1].push(row);
    else grouped.push([row.group, [row]]);
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="command-palette"
        className="w-full max-w-[560px] overflow-hidden rounded-card border border-line bg-[rgba(6,11,38,0.98)] shadow-glow-lg backdrop-blur"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="palette-input"
          placeholder="Search leads, companies and documents — or type a command"
          aria-label="Command palette"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              rows[active]?.run();
            }
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[14px] text-ink outline-none placeholder:text-muted"
        />

        <div className="max-h-[52vh] overflow-y-auto p-1.5" data-testid="palette-results">
          {rows.length === 0 && (
            <p className="px-3 py-4 text-[12.5px] text-muted">
              {q.trim().length > 0 && q.trim().length < MIN_QUERY_LENGTH
                ? "Keep typing…"
                : "Nothing matches that."}
            </p>
          )}
          {grouped.map(([group, groupRows]) => (
            <div key={group}>
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                {group}
              </p>
              {groupRows.map((row) => {
                const index = rows.indexOf(row);
                return (
                  <button
                    key={row.key}
                    type="button"
                    data-testid="palette-row"
                    onMouseEnter={() => setActive(index)}
                    onClick={row.run}
                    className={`flex w-full items-center gap-2 rounded-[9px] px-3 py-2 text-left text-[13px] ${
                      index === active ? "bg-accent-soft text-[#E4D3FF]" : "hover:bg-panel"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {row.label}
                      {row.detail && (
                        <span className="block truncate text-[11.5px] text-muted">
                          {row.detail}
                        </span>
                      )}
                    </span>
                    {row.hint && (
                      <kbd className="rounded-[5px] border border-line px-1.5 py-px text-[10.5px] text-muted">
                        {row.hint}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[10.5px] text-muted">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">? for every shortcut</span>
        </div>
      </div>
    </div>
  );
}

/** The `?` overlay. Generated from the same action list, so it cannot drift. */
function ShortcutOverlay({
  onClose,
  hidden,
}: {
  onClose: () => void;
  /** Documenting a shortcut to a screen the workspace removed is worse than
   *  documenting nothing — somebody presses it and lands where they were told
   *  the feature no longer is. */
  hidden: Set<string>;
}) {
  const bound = PALETTE_ACTIONS.filter((a) => a.hint && !isHrefHidden(a.href, hidden));
  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="shortcut-overlay"
        className="w-full max-w-[520px] rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur"
      >
        <div className="mb-3 flex items-center">
          <h3 className="font-display text-[18px] lowercase tracking-display">
            keyboard shortcuts
          </h3>
          <button onClick={onClose} className="ml-auto text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <dl className="grid gap-1.5">
          <Shortcut keys="⌘K / Ctrl-K" label="Command palette" />
          <Shortcut keys="/" label="Focus search" />
          {bound.map((a) => (
            <Shortcut key={a.id} keys={a.hint!} label={a.label} />
          ))}
          <Shortcut keys="esc" label="Close whatever is open" />
        </dl>

        <p className="mt-3 text-[11.5px] text-muted">
          Shortcuts are off while you are typing in a field — otherwise “n” in a
          note would open a dialog and take the note with it.
        </p>
      </div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[8px] px-2 py-1 text-[12.5px]">
      <kbd className="min-w-[74px] rounded-[6px] border border-line px-2 py-0.5 text-center text-[11px] text-muted">
        {keys}
      </kbd>
      <span>{label}</span>
    </div>
  );
}
