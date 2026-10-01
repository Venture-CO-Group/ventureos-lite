"use client";

import { useState, useTransition } from "react";
import { attempt } from "@/lib/client/server-action";
import { suggestFromReferences } from "@/modules/outbound/reference-actions";
import type { ProfileSuggestion } from "@/modules/outbound/profile-seed";
import type { ProductView, ProfileView, SegmentView } from "@/modules/outbound/catalog";

/**
 * Pre-fill a profile from the product's reference companies (spec §4.43.2c).
 *
 * Every suggestion shows which references produced it, and applying it only
 * fills the form — saving is still the person's own click. The copy says this
 * is a convenience, because a pattern derived from two companies is a hint and
 * not a finding.
 */
export function ReferenceSuggest({
  product,
  segments,
  canApply,
  onApply,
}: {
  product: ProductView;
  segments: SegmentView[];
  canApply: boolean;
  onApply: (patch: Partial<ProfileView>) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState<ProfileSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const segName = (k: string) => segments.find((x) => x.key === k)?.name ?? k;

  if (product.references.length === 0) {
    return (
      <p className="text-[11.5px] text-muted">
        Add reference companies on the product to have the profile suggested from them.
      </p>
    );
  }

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(suggestFromReferences(product.id));
      if (!res.ok) setError(res.error);
      else setS(res.suggestion);
    });
  }

  const from = (names: string[]) => <span className="text-[10.5px] text-muted"> ← {names.join(", ")}</span>;

  return (
    <div className="grid gap-2 rounded-[10px] border border-line p-3" data-testid="reference-suggest">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-[12px] text-muted">
          Suggest from {Math.min(product.references.length, 5)} reference
          {product.references.length === 1 ? "" : "s"} — a starting point to edit, not an answer. Each uncached
          reference spends one registry lookup.
        </span>
        {canApply && (
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className="min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:border-accent disabled:opacity-45"
          >
            {pending ? "Fetching…" : "Suggest"}
          </button>
        )}
      </div>
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
      {s && (
        <div className="grid gap-1 text-[12px]">
          {s.segments.length > 0 && (
            <div>
              Segments: {s.segments.map((x) => <span key={x.value} className="mr-2">{segName(x.value)}{from(x.from)}</span>)}
            </div>
          )}
          {s.unmatchedActivities.length > 0 && (
            <div className="text-muted">
              Activities no segment covers: {s.unmatchedActivities.map((x) => `${x.value} (${x.from.join(", ")})`).join("; ")}
            </div>
          )}
          {s.sizeBands.length > 0 && (
            <div>Size: {s.sizeBands.map((x) => <span key={x.value} className="mr-2">{x.value.toLowerCase()}{from(x.from)}</span>)}</div>
          )}
          {s.legalForms.length > 0 && (
            <div>Legal forms: {s.legalForms.map((x) => <span key={x.value} className="mr-2">{x.value}{from(x.from)}</span>)}</div>
          )}
          {s.counties.length > 0 && (
            <div>Counties: {s.counties.map((x) => <span key={x.value} className="mr-2">{x.value}{from(x.from)}</span>)}</div>
          )}
          {s.missing.length > 0 && <div className="text-muted">No datasheet for: {s.missing.join(", ")}</div>}
          {canApply && (
            <button
              type="button"
              onClick={() =>
                onApply({
                  segmentKeys: s.segments.map((x) => x.value),
                  sizeBands: s.sizeBands.map((x) => x.value),
                  legalForms: s.legalForms.map((x) => x.value),
                  counties: s.counties.map((x) => x.value),
                })
              }
              className="mt-1 min-h-[36px] justify-self-start rounded-[8px] border border-accent px-2.5 py-1.5 text-[11.5px] font-semibold text-ink"
            >
              Fill the form with this
            </button>
          )}
        </div>
      )}
    </div>
  );
}
