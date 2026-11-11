"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { saveFinderList } from "@/modules/finder/actions";
import {
  CONTACT_REQUIREMENTS,
  FINDER_BUSINESS_TYPES,
  FINDER_STATUSES,
  HU_COUNTIES,
  LEGAL_FORMS,
  type FinderCriteria,
} from "@/modules/finder/criteria";
import { SIZE_BAND_DEFS, type SizeBand } from "@/modules/outbound/size-band";

/**
 * The Company Finder's filter definition (item 1). One form, saved as a
 * reusable list. The banner at the top is not decoration: the registry can
 * only search by NAME, so the person defining a list has to know that every
 * other field is checked here, on datasheets we retrieve — and that a new
 * datasheet costs quota.
 */

export const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
export const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
export const BUTTON =
  "min-h-[44px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45 sm:min-h-[40px]";
export const PRIMARY =
  "min-h-[44px] rounded-[9px] border border-accent bg-[linear-gradient(135deg,#310B59,#7427C6)] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_0_18px_rgba(116,39,198,0.35)] disabled:opacity-45 sm:min-h-[40px]";

const STATUS_LABEL: Record<(typeof FINDER_STATUSES)[number], string> = {
  Aktív: "Active (Aktív)",
  "Eljárás alatt": "Under procedure (Eljárás alatt)",
  Szüneteltetett: "Suspended (Szüneteltetett)",
  any: "Any status",
};
const BUSINESS_LABEL: Record<(typeof FINDER_BUSINESS_TYPES)[number], string> = {
  company: "Companies (Kft., Zrt., Bt. …)",
  individualEntrepreneur: "Individual entrepreneurs only",
  both: "Companies and individual entrepreneurs",
};
const CONTACT_LABEL: Record<(typeof CONTACT_REQUIREMENTS)[number], string> = {
  none: "No requirement",
  any: "Any contact (email, phone or website)",
  email: "Must have an email",
  phone: "Must have a phone",
  website: "Must have a website",
};

const splitList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Million forints in the form, whole forints in the criteria (HUF as integers). */
const toForints = (m: string): number | null => {
  const v = Number(m.replace(",", ".").replace(/\s/g, ""));
  return m.trim() === "" || !Number.isFinite(v) || v < 0 ? null : Math.round(v * 1_000_000);
};
const toMillions = (f: number | null) => (f === null ? "" : String(f / 1_000_000));

export interface SegmentOption {
  key: string;
  name: string;
  fragments: number;
}

export function FinderEditor({
  listId,
  initialName,
  initial,
  initialCachedOnly = false,
  segments,
  canEdit,
  onSaved,
}: {
  listId?: string;
  initialName: string;
  initial: FinderCriteria;
  initialCachedOnly?: boolean;
  segments: SegmentOption[];
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(initialName);
  const [c, setC] = useState<FinderCriteria>(initial);
  const [keywords, setKeywords] = useState(initial.keywords.join(", "));
  const [teaorIn, setTeaorIn] = useState(initial.teaorInclude.join(", "));
  const [teaorOut, setTeaorOut] = useState(initial.teaorExclude.join(", "));
  const [cities, setCities] = useState(initial.cities.join(", "));
  const [revMin, setRevMin] = useState(toMillions(initial.revenueMin));
  const [revMax, setRevMax] = useState(toMillions(initial.revenueMax));
  const [cachedOnly, setCachedOnly] = useState(initialCachedOnly);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const set = <K extends keyof FinderCriteria>(k: K, v: FinderCriteria[K]) => {
    setC((prev) => ({ ...prev, [k]: v }));
    setSaved(null);
  };
  const toggle = <T extends string>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  function save() {
    setError(null);
    const criteria = {
      ...c,
      keywords: splitList(keywords),
      teaorInclude: splitList(teaorIn),
      teaorExclude: splitList(teaorOut),
      cities: splitList(cities),
      revenueMin: toForints(revMin),
      revenueMax: toForints(revMax),
    };
    startTransition(async () => {
      const res = await attempt(saveFinderList({ id: listId, name, criteria, cachedOnly }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved("Saved.");
      onSaved?.();
      if (!listId) router.push(`/finder/${res.id}`);
      else router.refresh();
    });
  }

  const noSource = !cachedOnly && c.segmentKeys.length === 0 && splitList(keywords).length === 0;

  return (
    <section className="grid gap-4 rounded-card border border-line bg-panel p-[18px]" data-testid="finder-editor">
      <p
        className="rounded-[10px] border border-line bg-[rgba(116,39,198,0.08)] p-3 text-[12px] leading-relaxed text-ink"
        data-testid="finder-local-notice"
      >
        <b>Filtering happens here, not at the registry.</b> Cégadat&apos;s search only matches company names, so segment
        fragments and keywords are used to <i>harvest</i> candidates (free). Every other criterion below — activity code,
        size, revenue, region, legal form, founding date, contacts — is applied locally, on each company&apos;s datasheet:
        cached datasheets are free, new ones count against the monthly lookup quota.
      </p>
      {error && <p className="text-[12px] text-[#FFB3C2]" role="alert">{error}</p>}

      <label className="grid gap-1">
        <span className={LABEL}>List name</span>
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Budapest micro IT firms" disabled={!canEdit} />
      </label>

      <fieldset className="grid gap-2" disabled={!canEdit}>
        <legend className={LABEL}>What to harvest</legend>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => (
            <label key={s.key} className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={c.segmentKeys.includes(s.key)} onChange={() => set("segmentKeys", toggle(c.segmentKeys, s.key))} />
              <span className="truncate">{s.name}</span>
              <span className="text-[11px] text-muted tabular-nums">{s.fragments} fragments</span>
            </label>
          ))}
        </div>
        <label className="grid gap-1">
          <span className={LABEL}>Name keywords (comma-separated, 4+ characters each — each becomes a harvest fragment)</span>
          <input className={INPUT} value={keywords} onChange={(e) => { setKeywords(e.target.value); setSaved(null); }} placeholder="szoftver, informatika" />
        </label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!canEdit}>
        <legend className={`${LABEL} mb-1`}>Activity (TEÁOR) — filtered locally</legend>
        <label className="grid gap-1">
          <span className={LABEL}>Include codes (prefixes)</span>
          <input className={INPUT} value={teaorIn} onChange={(e) => { setTeaorIn(e.target.value); setSaved(null); }} placeholder="62, 6311" />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Exclude codes (prefixes)</span>
          <input className={INPUT} value={teaorOut} onChange={(e) => { setTeaorOut(e.target.value); setSaved(null); }} placeholder="6209" />
        </label>
        <label className="flex min-h-[36px] items-center gap-2 text-[12.5px] sm:col-span-2">
          <input type="checkbox" checked={c.teaorAllActivities} onChange={(e) => set("teaorAllActivities", e.target.checked)} />
          Also match against every registered activity, not only the principal one
        </label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!canEdit}>
        <legend className={`${LABEL} mb-1`}>Size and money — filtered locally</legend>
        <div className="grid gap-1.5">
          <span className={LABEL}>Size bands (headcount; net revenue when headcount is missing)</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {SIZE_BAND_DEFS.map((d) => (
              <label key={d.band} className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={c.sizeBands.includes(d.band)} onChange={() => set("sizeBands", toggle<SizeBand>(c.sizeBands, d.band))} />
                {d.label}
              </label>
            ))}
          </div>
          <label className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={c.includeUnknownSize} onChange={(e) => set("includeUnknownSize", e.target.checked)} />
            Include companies whose size is unknown
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className={LABEL}>Revenue min (M Ft)</span>
            <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={revMin} onChange={(e) => { setRevMin(e.target.value); setSaved(null); }} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Revenue max (M Ft)</span>
            <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={revMax} onChange={(e) => { setRevMax(e.target.value); setSaved(null); }} />
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-2" disabled={!canEdit}>
        <legend className={`${LABEL} mb-1`}>Region — filtered locally</legend>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-4">
          {HU_COUNTIES.map((county) => (
            <label key={county} className="flex min-h-[32px] items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={c.counties.includes(county)} onChange={() => set("counties", toggle(c.counties, county))} />
              {county}
            </label>
          ))}
        </div>
        <label className="grid gap-1">
          <span className={LABEL}>Cities (comma-separated; a company in a listed county OR city matches)</span>
          <input className={INPUT} value={cities} onChange={(e) => { setCities(e.target.value); setSaved(null); }} placeholder="Debrecen, Szeged" />
        </label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" disabled={!canEdit}>
        <legend className={`${LABEL} mb-1`}>Company — filtered locally</legend>
        <div className="grid gap-1 sm:col-span-2 lg:col-span-3">
          <span className={LABEL}>Legal forms (none ticked = any)</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {LEGAL_FORMS.map((f) => (
              <label key={f} className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={c.legalForms.includes(f)} onChange={() => set("legalForms", toggle(c.legalForms, f))} />
                {f}
              </label>
            ))}
          </div>
        </div>
        <label className="grid gap-1">
          <span className={LABEL}>Founded from</span>
          <input className={INPUT} value={c.foundedFrom ?? ""} placeholder="2015 or 2015-06-01" onChange={(e) => set("foundedFrom", e.target.value.trim() || null)} />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Founded to</span>
          <input className={INPUT} value={c.foundedTo ?? ""} placeholder="2024-12-31" onChange={(e) => set("foundedTo", e.target.value.trim() || null)} />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Status</span>
          <select className={INPUT} value={c.status} onChange={(e) => set("status", e.target.value as FinderCriteria["status"])}>
            {FINDER_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Business type</span>
          <select className={INPUT} value={c.businessType} onChange={(e) => set("businessType", e.target.value as FinderCriteria["businessType"])}>
            {FINDER_BUSINESS_TYPES.map((s) => (
              <option key={s} value={s}>{BUSINESS_LABEL[s]}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Contact requirement</span>
          <select className={INPUT} value={c.contactRequirement} onChange={(e) => set("contactRequirement", e.target.value as FinderCriteria["contactRequirement"])}>
            {CONTACT_REQUIREMENTS.map((s) => (
              <option key={s} value={s}>{CONTACT_LABEL[s]}</option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="grid gap-1" disabled={!canEdit}>
        <legend className={`${LABEL} mb-1`}>Exclusions (free — checked before any lookup)</legend>
        <label className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={c.excludeInCrm} onChange={(e) => set("excludeInCrm", e.target.checked)} />
          Exclude companies already in the CRM
        </label>
        <label className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={c.excludeSuppressed} onChange={(e) => set("excludeSuppressed", e.target.checked)} />
          Exclude the suppression list
        </label>
      </fieldset>

      <fieldset className="grid gap-1" disabled={!canEdit}>
        <legend className={`${LABEL} mb-1`}>Data source</legend>
        <label className="flex min-h-[36px] items-start gap-2 text-[12.5px]" data-testid="finder-cached-only">
          <input type="checkbox" className="mt-1" checked={cachedOnly} onChange={(e) => { setCachedOnly(e.target.checked); setSaved(null); }} />
          <span>
            <b>Cached datasheets only</b> — filter the company database we have already built up, spending zero quota. No
            harvest, no lookups: keywords then match company names, segments match activity codes.
          </span>
        </label>
      </fieldset>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY} disabled={pending || !name.trim()} onClick={save} data-testid="finder-save">
            {pending ? "Saving…" : listId ? "Save list" : "Create list"}
          </button>
          {noSource && <span className="text-[11.5px] text-[#FFD27A]">Pick a segment or add a keyword — otherwise there is nothing to harvest.</span>}
          {saved && <span className="text-[11.5px] text-muted">{saved}</span>}
        </div>
      )}
    </section>
  );
}
