"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { saveSegment } from "@/modules/outbound/catalog-actions";
import { harvestNow } from "@/modules/outbound/run-actions";
import type { SegmentView } from "@/modules/outbound/catalog";
import { SOURCING_HINT_LABEL } from "@/modules/outbound/segments-seed";
import type { FragmentYield } from "@/modules/outbound/metrics";

/**
 * The segment taxonomy (spec §4.43.2–3, §9bis).
 *
 * Name fragments are first-class content: they decide what the free harvest
 * finds, and each one's yield is measured against the version it ran under.
 * Saving a change to fragments, seeds or TEÁOR codes bumps the version.
 */

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";


export function OutboundSegments({
  segments,
  canEdit,
  yields,
}: {
  segments: SegmentView[];
  canEdit: boolean;
  /** Per segment key, per fragment: candidates found and how many reached approval. */
  yields: Record<string, FragmentYield[]>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="grid gap-2" data-testid="segment-list">
      {segments.map((s) => (
        <div key={s.id} className="rounded-card border border-line bg-panel">
          <button
            type="button"
            className="flex w-full flex-wrap items-center gap-2 p-3 text-left"
            onClick={() => setOpen(open === s.id ? null : s.id)}
            aria-expanded={open === s.id}
          >
            <span className={`min-w-0 flex-1 truncate text-[13.5px] font-semibold ${s.archived ? "text-muted line-through" : "text-ink"}`}>
              {s.name}
            </span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
              {SOURCING_HINT_LABEL[s.sourcingHint]}
            </span>
            <span className="text-[11px] tabular-nums text-muted">
              {s.fragments.length} fragments · {s.seedList.length} seeds · v{s.version}
            </span>
          </button>
          {open === s.id && <SegmentEditor segment={s} canEdit={canEdit} yields={yields[s.key] ?? []} />}
        </div>
      ))}
    </div>
  );
}

function SegmentEditor({ segment, canEdit, yields }: { segment: SegmentView; canEdit: boolean; yields: FragmentYield[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(segment.name);
  const [hint, setHint] = useState(segment.sourcingHint);
  const [fragments, setFragments] = useState(segment.fragments.join("\n"));
  const [include, setInclude] = useState(segment.teaorInclude.join(", "));
  const [exclude, setExclude] = useState(segment.teaorExclude.join(", "));
  const [seeds, setSeeds] = useState(segment.seedList.map((e) => e.taxNumber ?? e.name ?? "").join("\n"));
  const [archived, setArchived] = useState(segment.archived);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [harvestMsg, setHarvestMsg] = useState<string | null>(null);
  const disabled = !canEdit || pending;

  const split = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await attempt(
        saveSegment({
          id: segment.id,
          name,
          sourcingHint: hint,
          fragments: split(fragments, /\n/),
          teaorInclude: split(include, /[,\s]+/),
          teaorExclude: split(exclude, /[,\s]+/),
          // A line of digits and dashes is a tax number; anything else a name.
          seedList: split(seeds, /\n/).map((l) => (/^[0-9-]{8,13}$/.test(l) ? { taxNumber: l } : { name: l })),
          archived,
        }),
      );
      if (!res.ok) setError(res.error);
      else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  const byFragment = new Map(yields.map((y) => [y.fragment, y]));

  return (
    <div className="grid gap-3 border-t border-line p-3">
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={LABEL}>Name</span>
          <input className={INPUT} value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Carried by</span>
          <select className={INPUT} value={hint} disabled={disabled} onChange={(e) => setHint(e.target.value as SegmentView["sourcingHint"])}>
            {Object.entries(SOURCING_HINT_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>TEÁOR include (prefixes)</span>
          <input className={`${INPUT} tabular-nums`} value={include} disabled={disabled} onChange={(e) => setInclude(e.target.value)} />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>TEÁOR exclude</span>
          <input className={`${INPUT} tabular-nums`} value={exclude} disabled={disabled} onChange={(e) => setExclude(e.target.value)} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={LABEL}>Name fragments — one per line</span>
          <textarea className={`${INPUT} min-h-[160px]`} value={fragments} disabled={disabled} onChange={(e) => setFragments(e.target.value)} />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Seed list — a company name or tax number per line</span>
          <textarea className={`${INPUT} min-h-[160px]`} value={seeds} disabled={disabled} onChange={(e) => setSeeds(e.target.value)} />
        </label>
      </div>
      {segment.fragments.length > 0 && (
        <div className="grid gap-1" data-testid="fragment-yield">
          <span className={LABEL}>Fragment yield (candidates found → approved)</span>
          <div className="flex flex-wrap gap-1.5">
            {segment.fragments.map((f) => {
              const y = byFragment.get(f);
              const weak = y && y.sourced >= 20 && y.approved === 0;
              return (
                <span
                  key={f}
                  className={`rounded-full border px-2 py-0.5 text-[11px] tabular-nums ${weak ? "border-[#FF5C7A] text-[#FFB3C2]" : "border-line text-muted"}`}
                  title={weak ? "20+ candidates and none approved — a retirement candidate" : undefined}
                >
                  {f} · {y?.sourced ?? 0} → {y?.approved ?? 0}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45"
          >
            {pending ? "Saving…" : "Save segment"}
          </button>
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={archived} disabled={disabled} onChange={(e) => setArchived(e.target.checked)} />
            archived
          </label>
          {saved && <span className="text-[11.5px] text-pos">saved</span>}
          {segment.fragments.length > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const res = await attempt(harvestNow(segment.key));
                  if (!res.ok) setError(res.error);
                  else {
                    setHarvestMsg(
                      `${res.created} new, ${res.updated} seen again${res.errors.length ? ` · ${res.errors.length} fragment(s) failed: ${res.errors[0]}` : ""}`,
                    );
                    router.refresh();
                  }
                })
              }
              className="ml-auto min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] text-muted hover:text-ink disabled:opacity-45"
              title="One page per fragment from the free registry search — spends no quota."
            >
              Harvest now
            </button>
          )}
          {harvestMsg && <span className="w-full text-[11.5px] text-muted">{harvestMsg}</span>}
        </div>
      )}
    </div>
  );
}
