"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useToast } from "./toast";
import { useSlowAction } from "./use-slow-action";

/**
 * Editing in place, everywhere (playbook-v5 P16/1).
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * `InlineCell` already did this for the leads table, and it did it well: click
 * or Enter to edit, Esc to cancel, Enter or blur to commit, arrows and Tab to
 * move, optimistic value replaced by whatever the SERVER says it stored. What
 * it could not do was leave a table — the keyboard model was built on
 * `data-cell` grid coordinates, so a detail panel or a kanban card had nowhere
 * to put it. Three surfaces had grown their own save-button forms instead.
 *
 * So the control is now layout-agnostic and the grid is an OPTION. `InlineCell`
 * is the table binding, `InlineField` the detail-panel binding, and both are
 * thin.
 *
 * ── WHY THE SERVER'S ANSWER REPLACES THE OPTIMISTIC ONE ─────────────────────
 *
 * The optimistic update is a display convenience and never an authorization
 * shortcut. Every commit runs the real server rules — grants, tenant guard,
 * score gate, field validation — and the cell renders what comes BACK: a
 * trimmed string, a cleared field, a coerced number. A cell can therefore
 * never sit there showing something the database does not hold.
 *
 * ── WHY A REFUSAL IS BOTH IN PLACE AND IN A TOAST ───────────────────────────
 *
 * In place, because the person is looking at the cell and the previous value
 * has to visibly come back. In a toast, because the reason is often longer than
 * a cell is wide — "Disqualifying needs a reason, open the lead to do it" does
 * not fit in a table column, and a truncated explanation is not one. What it is
 * NOT is a dialog: a table where every mistyped email opens a modal is a table
 * nobody edits twice.
 *
 * ── AND WHY READ-ONLY STATES CARRY A REASON ─────────────────────────────────
 *
 * A cell that silently refuses to open reads as broken. One that says "the ICP
 * score has an audited override — open the lead" teaches the model instead.
 */

export type InlineKind = "text" | "number" | "date" | "select" | "multiselect" | "checkbox";

export interface InlineOption {
  value: string;
  label: string;
}

export type InlineValue = string | string[] | boolean | null;

export type InlineSaveResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Grid coordinates. Only tables have them, so only tables pass them. */
export interface CellCoords {
  row: number;
  col: number;
}

export interface InlineEditProps {
  value: InlineValue;
  /** What is shown when not editing. */
  display: ReactNode;
  kind: InlineKind;
  /** Names the field for assistive tech and for the "Edit X" affordance. */
  label: string;
  options?: InlineOption[];
  editable?: boolean;
  /**
   * Why this is read-only for this person. Shown as the tooltip, so it is
   * written for them: "documents.send is granted per person" beats "no grant".
   */
  reason?: string;
  placeholder?: string;
  /** Table keyboard movement. Omit outside a table. */
  cell?: CellCoords;
  /**
   * What opens the editor.
   *
   * "click" everywhere the field is the only thing the element does — a table
   * cell, a panel field. "doubleClick" where a single click already MEANS
   * something: a kanban card's title opens the task, and taking that gesture
   * away to reveal a text input would break the primary action of the board to
   * serve the rarer one. Enter still works on a focused title in both modes,
   * so the keyboard path is unchanged.
   */
  activateOn?: "click" | "doubleClick";
  className?: string;
  onSave: (next: InlineValue) => Promise<InlineSaveResult>;
}

const READ = "w-full min-w-0 rounded-[6px] px-1 py-0.5 text-left outline-none transition-colors";
const EDIT =
  "w-full min-w-0 rounded-[6px] border border-accent bg-[rgba(0,5,29,0.6)] px-1 py-0.5 text-[12.5px] text-ink outline-none";

export function InlineEdit({
  value,
  display,
  kind,
  label,
  options = [],
  editable = true,
  reason,
  placeholder,
  cell,
  activateOn = "click",
  className = "",
  onSave,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<InlineValue>(value);
  const [shown, setShown] = useState<ReactNode>(display);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  /**
   * Dimmed only once the commit is genuinely slow. A cell edit is usually a
   * single indexed UPDATE and answers in well under the threshold, so showing
   * "saving" immediately would flicker on every keystroke-and-Enter.
   */
  const { slow: saving, run } = useSlowAction();
  const ref = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const toast = useToast();
  const describedBy = useId();

  // A fresh server render is the truth; drop any local echo of an older one.
  useEffect(() => {
    setShown(display);
    setDraft(value);
    // `display` is a node and changes identity every render, so this is keyed
    // on the VALUE — the thing that actually decides what to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  /**
   * Move focus by grid coordinates, read from the DOM rather than from state.
   * The table re-renders on every save, and a stateful focus index would point
   * at the wrong row the moment a sort changed under it.
   */
  function move(dRow: number, dCol: number) {
    if (!cell) return;
    document
      .querySelector<HTMLElement>(`[data-cell="${cell.row + dRow}:${cell.col + dCol}"]`)
      ?.focus();
  }

  async function commit(next: InlineValue) {
    setEditing(false);
    if (JSON.stringify(next) === JSON.stringify(value)) return;

    setError(null);
    const res = await run(() => onSave(next));

    if (!res.ok) {
      // Put the previous value back, and say why in both places.
      setDraft(value);
      setShown(display);
      setError(res.error);
      toast.error(res.error);
      return;
    }
    setError(null);
    setShown(formatSaved(res.value, options));
    setFlash(true);
    window.setTimeout(() => setFlash(false), 700);
  }

  if (!editable) {
    return (
      <span
        data-testid="inline-readonly"
        aria-disabled="true"
        title={reason ?? `${label} cannot be edited here`}
        className={`text-[12.5px] text-muted ${
          reason ? "cursor-help decoration-dotted underline-offset-2 hover:underline" : ""
        } ${className}`}
      >
        {shown || <span className="text-muted">—</span>}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        data-cell={cell ? `${cell.row}:${cell.col}` : undefined}
        data-testid="inline-cell"
        data-error={error ? "true" : undefined}
        aria-label={`Edit ${label}`}
        aria-describedby={error ? describedBy : undefined}
        title={error ?? (activateOn === "doubleClick" ? `Double-click to edit ${label}` : `Edit ${label}`)}
        onClick={activateOn === "click" ? () => setEditing(true) : undefined}
        onDoubleClick={activateOn === "doubleClick" ? () => setEditing(true) : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
            return;
          }
          if (!cell) return;
          if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
            e.preventDefault();
            move(0, 1);
          } else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
            e.preventDefault();
            move(0, -1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1, 0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1, 0);
          }
        }}
        className={`${READ} hover:bg-panel focus-visible:ring-1 focus-visible:ring-accent ${
          error ? "text-[#FFB3C2]" : ""
        } ${flash ? "bg-[rgba(61,220,151,0.14)]" : ""} ${saving ? "opacity-60" : ""} ${className}`}
      >
        {shown || <span className="text-muted">{placeholder ?? "—"}</span>}
        {error && (
          <span id={describedBy} className="sr-only">
            {error}
          </span>
        )}
      </button>
    );
  }

  if (kind === "checkbox") {
    return (
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        type="checkbox"
        aria-label={label}
        checked={draft === true}
        onChange={(e) => void commit(e.target.checked)}
        onBlur={() => setEditing(false)}
        className="accent-[#7427C6]"
      />
    );
  }

  if (kind === "select" || kind === "multiselect") {
    const current = Array.isArray(draft) ? draft : draft === null ? "" : String(draft);
    return (
      <select
        ref={ref as React.RefObject<HTMLSelectElement>}
        aria-label={label}
        multiple={kind === "multiselect"}
        value={current as string | string[]}
        onChange={(e) => {
          const next =
            kind === "multiselect"
              ? [...e.target.selectedOptions].map((o) => o.value)
              : e.target.value || null;
          setDraft(next);
          if (kind === "select") void commit(next);
        }}
        onBlur={() => (kind === "multiselect" ? void commit(draft) : setEditing(false))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className={`${EDIT} ${className}`}
      >
        {kind === "select" && <option value="">—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
      aria-label={label}
      placeholder={placeholder}
      value={draft === null || typeof draft === "boolean" ? "" : String(draft)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className={`${EDIT} ${className}`}
    />
  );
}

/**
 * The table binding. Identical behaviour, plus the grid coordinates that make
 * arrow keys and Tab walk the cells.
 */
export function InlineCell(props: Omit<InlineEditProps, "cell"> & CellCoords) {
  const { row, col, ...rest } = props;
  return <InlineEdit {...rest} cell={{ row, col }} />;
}

/**
 * The detail-panel binding: a label above a full-width control, matching the
 * static fields it sits beside so a panel does not look half-converted.
 */
export function InlineField({
  label,
  hint,
  ...rest
}: Omit<InlineEditProps, "cell" | "label"> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      <span className="block rounded-[8px] border border-line bg-[rgba(0,5,29,0.35)] px-1.5 py-1">
        <InlineEdit label={label} {...rest} />
      </span>
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function formatSaved(value: unknown, options: InlineOption[]): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value.map((v) => options.find((o) => o.value === v)?.label ?? String(v)).join(", ");
  }
  const option = options.find((o) => o.value === String(value));
  return option ? option.label : String(value);
}
