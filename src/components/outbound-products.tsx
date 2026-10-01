"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import {
  saveProduct,
  deleteProduct,
  saveProfile,
  deleteProfile,
} from "@/modules/outbound/catalog-actions";
import type { ProductView, ProfileView, SegmentView } from "@/modules/outbound/catalog";
import { productDailyQuota } from "@/modules/outbound/catalog";
import { SIZE_BAND_DEFS, type SizeBand } from "@/modules/outbound/size-band";
import { SOURCING_HINT_LABEL } from "@/modules/outbound/segments-seed";
import { ReferenceSuggest } from "./outbound-reference-suggest";

/**
 * Products and their ICP profiles (playbook-v6 F1/5, spec §4.43.1–2).
 *
 * The profile editor follows the spec's three targeting layers in order —
 * segments, size bands, references — with the fine filters folded away behind
 * "More filters", because most profiles need none of them and a form that
 * shows twenty inputs reads as twenty decisions.
 */

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BUTTON =
  "min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45";
const PRIMARY =
  "min-h-[40px] rounded-[9px] border border-accent bg-[linear-gradient(135deg,#310B59,#7427C6)] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_0_18px_rgba(116,39,198,0.35)] disabled:opacity-45";

const STATUS_CHIP: Record<ProductView["status"], string> = {
  ACTIVE: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  PAUSED: "bg-panel text-muted",
  RETIRED: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]",
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const list = (s: string) =>
  s
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

function emptyProduct(): ProductView {
  return {
    id: "",
    name: "",
    slug: "",
    category: "OWN_SERVICE",
    partner: null,
    problemSolved: "",
    valueProps: [{ claim: "", evidence: "" }],
    proofPoints: [],
    priceBand: null,
    assets: [],
    status: "ACTIVE",
    language: "HU",
    priority: 0,
    references: [],
    profiles: [],
  };
}

function emptyProfile(productId: string): ProfileView {
  return {
    id: "",
    productId,
    name: "",
    segmentKeys: [],
    sizeBands: [],
    includeUnknownSize: false,
    revenueMin: null,
    revenueMax: null,
    counties: [],
    cities: [],
    legalForms: [],
    foundedAfter: null,
    foundedBefore: null,
    statusRequired: "Aktív",
    requiresWebsite: false,
    auditScoreMin: null,
    auditScoreMax: null,
    requiredSignals: [],
    contactRequirement: "GENERIC_OK",
    excludeExistingClients: true,
    mode: "VOLUME",
    dailyQuota: 0,
    weight: 1,
    active: true,
  };
}

export function OutboundProducts({
  products,
  segments,
  canEdit,
}: {
  products: ProductView[];
  segments: SegmentView[];
  canEdit: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(products[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const current = creating ? emptyProduct() : products.find((p) => p.id === selected) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="grid content-start gap-2" data-testid="product-list">
        {canEdit && (
          <button
            type="button"
            className={PRIMARY}
            onClick={() => {
              setCreating(true);
              setSelected(null);
            }}
            data-testid="product-new"
          >
            New product
          </button>
        )}
        {products.length === 0 && !creating && (
          <p className="rounded-card border border-line bg-panel p-4 text-[12.5px] text-muted">
            No products yet. A product is what the motor sells — every run starts from one.
            {canEdit ? "" : " An Owner adds them."}
          </p>
        )}
        {products.map((p) => {
          const active = p.profiles.filter((x) => x.active).length;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setCreating(false);
                setSelected(p.id);
              }}
              className={`grid gap-1 rounded-card border p-3 text-left ${
                p.id === selected && !creating ? "border-accent bg-panel" : "border-line bg-panel hover:border-accent"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${STATUS_CHIP[p.status]}`}>
                  {p.status.toLowerCase()}
                </span>
              </span>
              <span className="text-[11.5px] tabular-nums text-muted">
                {active} active profile{active === 1 ? "" : "s"} · {productDailyQuota(p.profiles)}/night
                {p.category === "PARTNER_SOLUTION" && p.partner ? ` · ${p.partner}` : ""}
              </span>
            </button>
          );
        })}
      </aside>

      <div className="grid min-w-0 content-start gap-4">
        {current ? (
          <>
            <ProductEditor
              key={current.id || "new"}
              product={current}
              canEdit={canEdit}
              onSaved={(id) => {
                setCreating(false);
                setSelected(id);
              }}
              onDeleted={() => setSelected(null)}
            />
            {current.id && (
              <ProfilesPanel product={current} segments={segments} canEdit={canEdit} />
            )}
          </>
        ) : (
          <p className="text-[12.5px] text-muted">Select a product.</p>
        )}
      </div>
    </div>
  );
}

// ---- product ----------------------------------------------------------------

function ProductEditor({
  product,
  canEdit,
  onSaved,
  onDeleted,
}: {
  product: ProductView;
  canEdit: boolean;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [p, setP] = useState(product);
  const [proof, setProof] = useState(product.proofPoints.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const disabled = !canEdit || pending;

  function patch(next: Partial<ProductView>) {
    setSaved(false);
    setP((cur) => ({ ...cur, ...next }));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(
        saveProduct({
          ...(p.id ? { id: p.id } : {}),
          name: p.name,
          slug: p.slug || undefined,
          category: p.category,
          partner: p.partner,
          problemSolved: p.problemSolved,
          valueProps: p.valueProps.filter((v) => v.claim.trim() || v.evidence.trim()),
          proofPoints: lines(proof),
          priceBand: p.priceBand,
          assets: p.assets.filter((a) => a.label.trim() || a.url.trim()),
          status: p.status,
          language: p.language,
          priority: p.priority,
          references: p.references
            .filter((r) => r.companyName.trim())
            .map((r) => ({ companyName: r.companyName, taxNumber: r.taxNumber, isClient: r.isClient, note: r.note })),
        }),
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved(true);
      onSaved(res.id);
      router.refresh();
    });
  }

  function remove() {
    if (!p.id || !window.confirm(`Delete "${p.name}" and all its profiles?`)) return;
    startTransition(async () => {
      const res = await attempt(deleteProduct(p.id));
      if (!res.ok) setError(res.error);
      else {
        onDeleted();
        router.refresh();
      }
    });
  }

  return (
    <section className="grid gap-3 rounded-card border border-line bg-panel p-[18px]" data-testid="product-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 font-display text-[18px] font-bold lowercase">
          {p.id ? p.name || "product" : "new product"}
        </h3>
        {!canEdit && <span className="text-[11.5px] text-muted">read-only — an Owner edits products</span>}
      </div>
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={LABEL}>Name</span>
          <input className={INPUT} value={p.name} disabled={disabled} onChange={(e) => patch({ name: e.target.value })} data-testid="product-name" />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Category</span>
          <select
            className={INPUT}
            value={p.category}
            disabled={disabled}
            onChange={(e) => patch({ category: e.target.value as ProductView["category"] })}
          >
            <option value="OWN_SERVICE">Own service</option>
            <option value="PARTNER_SOLUTION">Partner solution</option>
          </select>
        </label>
        {p.category === "PARTNER_SOLUTION" && (
          <label className="grid gap-1">
            <span className={LABEL}>Partner (supplier)</span>
            <input className={INPUT} value={p.partner ?? ""} disabled={disabled} onChange={(e) => patch({ partner: e.target.value || null })} />
          </label>
        )}
        <label className="grid gap-1">
          <span className={LABEL}>Status</span>
          <select className={INPUT} value={p.status} disabled={disabled} onChange={(e) => patch({ status: e.target.value as ProductView["status"] })}>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="RETIRED">Retired</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Outreach language</span>
          <select className={INPUT} value={p.language} disabled={disabled} onChange={(e) => patch({ language: e.target.value as ProductView["language"] })}>
            <option value="HU">Hungarian</option>
            <option value="EN">English</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Price band (order of magnitude)</span>
          <input className={INPUT} value={p.priceBand ?? ""} disabled={disabled} onChange={(e) => patch({ priceBand: e.target.value || null })} placeholder="1–3 M Ft" />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Priority (higher gets quota first)</span>
          <input
            className={`${INPUT} tabular-nums`}
            type="number"
            min={0}
            max={100}
            value={p.priority}
            disabled={disabled}
            onChange={(e) => patch({ priority: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <label className="grid gap-1">
        <span className={LABEL}>Problem solved</span>
        <textarea
          className={`${INPUT} min-h-[64px]`}
          value={p.problemSolved}
          disabled={disabled}
          onChange={(e) => patch({ problemSolved: e.target.value })}
          placeholder="One or two sentences: which pain this answers."
          data-testid="product-problem"
        />
      </label>

      <div className="grid gap-1.5">
        <span className={LABEL}>Value propositions — each with its evidence</span>
        {p.valueProps.map((v, i) => (
          <div key={i} className="grid gap-1.5 sm:grid-cols-[1fr_1fr_auto]">
            <input
              className={INPUT}
              value={v.claim}
              disabled={disabled}
              placeholder="Claim"
              onChange={(e) => patch({ valueProps: p.valueProps.map((x, j) => (j === i ? { ...x, claim: e.target.value } : x)) })}
            />
            <input
              className={INPUT}
              value={v.evidence}
              disabled={disabled}
              placeholder="Evidence"
              onChange={(e) => patch({ valueProps: p.valueProps.map((x, j) => (j === i ? { ...x, evidence: e.target.value } : x)) })}
            />
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => patch({ valueProps: p.valueProps.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        {canEdit && p.valueProps.length < 8 && (
          <button type="button" className={`${BUTTON} justify-self-start`} disabled={disabled} onClick={() => patch({ valueProps: [...p.valueProps, { claim: "", evidence: "" }] })}>
            Add value proposition
          </button>
        )}
      </div>

      <label className="grid gap-1">
        <span className={LABEL}>Proof points — one per line, real only</span>
        <textarea className={`${INPUT} min-h-[56px]`} value={proof} disabled={disabled} onChange={(e) => { setSaved(false); setProof(e.target.value); }} />
      </label>

      <div className="grid gap-1.5">
        <span className={LABEL}>Assets</span>
        {p.assets.map((a, i) => (
          <div key={i} className="grid gap-1.5 sm:grid-cols-[1fr_2fr_auto]">
            <input className={INPUT} value={a.label} disabled={disabled} placeholder="One-pager" onChange={(e) => patch({ assets: p.assets.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input className={INPUT} value={a.url} disabled={disabled} placeholder="https://…" onChange={(e) => patch({ assets: p.assets.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => patch({ assets: p.assets.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        {canEdit && (
          <button type="button" className={`${BUTTON} justify-self-start`} disabled={disabled} onClick={() => patch({ assets: [...p.assets, { label: "", url: "" }] })}>
            Add asset
          </button>
        )}
      </div>

      <div className="grid gap-1.5" data-testid="product-references">
        <span className={LABEL}>Reference companies</span>
        <p className="text-[11.5px] text-muted">
          Tick <strong className="text-ink">our client</strong> only for a company we have actually worked for — only those may be
          named in an outbound message. Everything else is a targeting pattern and never appears in copy.
        </p>
        {p.references.map((r, i) => (
          <div key={i} className="grid items-center gap-1.5 sm:grid-cols-[2fr_1fr_auto_auto]">
            <input
              className={INPUT}
              value={r.companyName}
              disabled={disabled}
              placeholder="Company name"
              onChange={(e) => patch({ references: p.references.map((x, j) => (j === i ? { ...x, companyName: e.target.value } : x)) })}
            />
            <input
              className={INPUT}
              value={r.taxNumber ?? ""}
              disabled={disabled}
              placeholder="Tax number (optional)"
              onChange={(e) => patch({ references: p.references.map((x, j) => (j === i ? { ...x, taxNumber: e.target.value || null } : x)) })}
            />
            <label className="flex min-h-[40px] items-center gap-2 rounded-[9px] border border-line px-2.5 text-[12px]">
              <input
                type="checkbox"
                checked={r.isClient}
                disabled={disabled}
                onChange={(e) => patch({ references: p.references.map((x, j) => (j === i ? { ...x, isClient: e.target.checked } : x)) })}
                data-testid={`reference-client-${i}`}
              />
              <span className={r.isClient ? "text-ink" : "text-muted"}>our client — may be named in outreach</span>
            </label>
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => patch({ references: p.references.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        {canEdit && p.references.length < 20 && (
          <button
            type="button"
            className={`${BUTTON} justify-self-start`}
            disabled={disabled}
            onClick={() => patch({ references: [...p.references, { id: "", companyName: "", taxNumber: null, isClient: false, note: null }] })}
          >
            Add reference
          </button>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY} disabled={pending} onClick={save} data-testid="product-save">
            {pending ? "Saving…" : "Save product"}
          </button>
          {p.id && (
            <button type="button" className={BUTTON} disabled={pending} onClick={remove}>
              Delete
            </button>
          )}
          {saved && <span className="text-[11.5px] text-pos">saved</span>}
        </div>
      )}
    </section>
  );
}

// ---- profiles ---------------------------------------------------------------

function ProfilesPanel({
  product,
  segments,
  canEdit,
}: {
  product: ProductView;
  segments: SegmentView[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="grid gap-3" data-testid="profiles-panel">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-display text-[17px] font-bold lowercase">icp profiles</h3>
        {canEdit && !adding && (
          <button type="button" className={BUTTON} onClick={() => setAdding(true)} data-testid="profile-new">
            Add profile
          </button>
        )}
      </div>
      {product.profiles.length === 0 && !adding && (
        <p className="text-[12.5px] text-muted">No profile yet — a product without one is never sourced.</p>
      )}
      {product.profiles.map((pr) => (
        <ProfileEditor key={pr.id} product={product} profile={pr} segments={segments} canEdit={canEdit} />
      ))}
      {adding && (
        <ProfileEditor
          product={product}
          profile={emptyProfile(product.id)}
          segments={segments}
          canEdit={canEdit}
          onDone={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function ProfileEditor({
  product,
  profile,
  segments,
  canEdit,
  onDone,
}: {
  product: ProductView;
  profile: ProfileView;
  segments: SegmentView[];
  canEdit: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(profile);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const disabled = !canEdit || pending;
  const visibleSegments = segments.filter((s) => !s.archived || f.segmentKeys.includes(s.key));

  function patch(next: Partial<ProfileView>) {
    setSaved(false);
    setF((cur) => ({ ...cur, ...next }));
  }
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  function save() {
    setError(null);
    startTransition(async () => {
      const { id, ...rest } = f;
      const res = await attempt(saveProfile({ ...(id ? { id } : {}), ...rest }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved(true);
      onDone?.();
      router.refresh();
    });
  }

  function remove() {
    if (!f.id) {
      onDone?.();
      return;
    }
    if (!window.confirm(`Delete the profile "${f.name}"?`)) return;
    startTransition(async () => {
      const res = await attempt(deleteProfile(f.id));
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="grid gap-3 rounded-card border border-line bg-panel p-[18px]" data-testid="profile-editor">
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <label className="grid gap-1">
          <span className={LABEL}>Profile name</span>
          <input className={INPUT} value={f.name} disabled={disabled} onChange={(e) => patch({ name: e.target.value })} data-testid="profile-name" />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Drafts per night</span>
          <input
            className={`${INPUT} tabular-nums`}
            type="number"
            min={0}
            max={100}
            value={f.dailyQuota}
            disabled={disabled}
            onChange={(e) => patch({ dailyQuota: Number(e.target.value) || 0 })}
            data-testid="profile-quota"
          />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Mode</span>
          <select className={INPUT} value={f.mode} disabled={disabled} onChange={(e) => patch({ mode: e.target.value as ProfileView["mode"] })}>
            <option value="VOLUME">Volume</option>
            <option value="ACCOUNT">Account</option>
          </select>
        </label>
        <label className="flex min-h-[40px] items-center gap-2 self-end text-[12.5px]">
          <input type="checkbox" checked={f.active} disabled={disabled} onChange={(e) => patch({ active: e.target.checked })} />
          active
        </label>
      </div>

      <div className="grid gap-1.5">
        <span className={LABEL}>1 · Segments</span>
        <div className="flex flex-wrap gap-1.5">
          {visibleSegments.map((s) => {
            const on = f.segmentKeys.includes(s.key);
            return (
              <button
                key={s.key}
                type="button"
                disabled={disabled}
                onClick={() => patch({ segmentKeys: toggle(f.segmentKeys, s.key) })}
                aria-pressed={on}
                title={`Carried by: ${SOURCING_HINT_LABEL[s.sourcingHint]}`}
                className={`min-h-[36px] rounded-full border px-3 py-1 text-[12px] ${
                  on ? "border-accent bg-[rgba(116,39,198,0.18)] text-ink" : "border-line text-muted hover:text-ink"
                }`}
              >
                {s.name}
                <span className="ml-1.5 text-[10.5px] text-muted">· {SOURCING_HINT_LABEL[s.sourcingHint]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-1.5">
        <span className={LABEL}>2 · Size bands (by headcount, revenue as fallback)</span>
        <div className="flex flex-wrap gap-1.5">
          {SIZE_BAND_DEFS.map((d) => {
            const on = f.sizeBands.includes(d.band);
            return (
              <button
                key={d.band}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => patch({ sizeBands: toggle<SizeBand>(f.sizeBands, d.band) })}
                className={`min-h-[36px] rounded-full border px-3 py-1 text-[12px] ${
                  on ? "border-accent bg-[rgba(116,39,198,0.18)] text-ink" : "border-line text-muted hover:text-ink"
                }`}
              >
                {d.label}
              </button>
            );
          })}
          <label className="flex min-h-[36px] items-center gap-2 px-2 text-[12px] text-muted">
            <input type="checkbox" checked={f.includeUnknownSize} disabled={disabled} onChange={(e) => patch({ includeUnknownSize: e.target.checked })} />
            include companies of unknown size (flagged, queued last)
          </label>
        </div>
      </div>

      <div className="grid gap-1.5">
        <span className={LABEL}>3 · References</span>
        <ReferenceSuggest product={product} segments={segments} canApply={canEdit} onApply={(s) => patch(s)} />
      </div>

      <button type="button" className={`${BUTTON} justify-self-start`} onClick={() => setMore((m) => !m)} aria-expanded={more}>
        {more ? "Hide filters" : "More filters"}
      </button>
      {more && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className={LABEL}>Revenue min (Ft)</span>
            <input className={`${INPUT} tabular-nums`} inputMode="numeric" value={f.revenueMin ?? ""} disabled={disabled} onChange={(e) => patch({ revenueMin: num(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Revenue max (Ft)</span>
            <input className={`${INPUT} tabular-nums`} inputMode="numeric" value={f.revenueMax ?? ""} disabled={disabled} onChange={(e) => patch({ revenueMax: num(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Counties (comma-separated)</span>
            <input className={INPUT} value={f.counties.join(", ")} disabled={disabled} onChange={(e) => patch({ counties: list(e.target.value) })} placeholder="Budapest, Pest" />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Cities (comma-separated)</span>
            <input className={INPUT} value={f.cities.join(", ")} disabled={disabled} onChange={(e) => patch({ cities: list(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Legal forms (comma-separated)</span>
            <input className={INPUT} value={f.legalForms.join(", ")} disabled={disabled} onChange={(e) => patch({ legalForms: list(e.target.value) })} placeholder="Kft., Zrt." />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Registry status required</span>
            <input className={INPUT} value={f.statusRequired} disabled={disabled} onChange={(e) => patch({ statusRequired: e.target.value })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Founded after (year)</span>
            <input className={`${INPUT} tabular-nums`} inputMode="numeric" value={f.foundedAfter ?? ""} disabled={disabled} onChange={(e) => patch({ foundedAfter: num(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Founded before (year)</span>
            <input className={`${INPUT} tabular-nums`} inputMode="numeric" value={f.foundedBefore ?? ""} disabled={disabled} onChange={(e) => patch({ foundedBefore: num(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Audit score min</span>
            <input className={`${INPUT} tabular-nums`} inputMode="numeric" value={f.auditScoreMin ?? ""} disabled={disabled} onChange={(e) => patch({ auditScoreMin: num(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Audit score max</span>
            <input className={`${INPUT} tabular-nums`} inputMode="numeric" value={f.auditScoreMax ?? ""} disabled={disabled} onChange={(e) => patch({ auditScoreMax: num(e.target.value) })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Required signals (comma-separated)</span>
            <input className={INPUT} value={f.requiredSignals.join(", ")} disabled={disabled} onChange={(e) => patch({ requiredSignals: list(e.target.value) })} placeholder="no mobile layout" />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Contact</span>
            <select className={INPUT} value={f.contactRequirement} disabled={disabled} onChange={(e) => patch({ contactRequirement: e.target.value as ProfileView["contactRequirement"] })}>
              <option value="GENERIC_OK">A generic address is acceptable</option>
              <option value="NAMED_CONTACT">A named contact is required</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Weight within the product</span>
            <input className={`${INPUT} tabular-nums`} type="number" min={1} max={10} value={f.weight} disabled={disabled} onChange={(e) => patch({ weight: Number(e.target.value) || 1 })} />
          </label>
          <label className="flex min-h-[40px] items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={f.requiresWebsite} disabled={disabled} onChange={(e) => patch({ requiresWebsite: e.target.checked })} />
            requires a website
          </label>
          <label className="flex min-h-[40px] items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={f.excludeExistingClients} disabled={disabled} onChange={(e) => patch({ excludeExistingClients: e.target.checked })} />
            exclude existing clients
          </label>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY} disabled={pending} onClick={save} data-testid="profile-save">
            {pending ? "Saving…" : f.id ? "Save profile" : "Create profile"}
          </button>
          <button type="button" className={BUTTON} disabled={pending} onClick={remove}>
            {f.id ? "Delete" : "Cancel"}
          </button>
          {saved && <span className="text-[11.5px] text-pos">saved</span>}
        </div>
      )}
    </div>
  );
}
