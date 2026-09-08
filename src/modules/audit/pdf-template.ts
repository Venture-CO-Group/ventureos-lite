import type { AuditView } from "./types";
import { scoreByCategory, ungroupedChecks, CATEGORY_LABEL } from "./categories";
import { analyzeStructure } from "./structure";
import { formatMetric, verdictFor, fieldSummaryEn } from "./crux";
import type { ComparisonTable } from "./comparison";
import { buildPriorityMatrix, QUADRANTS, EFFORT_LABEL } from "./priority";
import { VENTURE_BRAND, brandGradient, type WorkspaceBrand } from "../workspaces/brand";
import { brandRootStyle } from "../workspaces/letterhead";

/**
 * Branded audit one-pager (spec §4.4). A self-contained HTML doc — no external
 * assets — printed to PDF by the headless-Chrome pipeline. Venture letterhead
 * from the design tokens (docs/prototype.html). Also drives the public share
 * page's report body.
 */

const VERDICT_LABEL: Record<string, string> = {
  STRONG: "Strong prospect",
  POSSIBLE: "Possible",
  SKIP: "Skip",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface AuditDocOptions {
  /** Deprecated in favour of `brand`; still honoured for the footer line. */
  brandName?: string;
  /** Whose report this is (P2/6). Defaults to Venture, the seed brand. */
  brand?: WorkspaceBrand;
  generatedAt?: Date;
  /** Competitor side-by-side (P2/3) — named, because this is the sales PDF. */
  comparison?: ComparisonTable | null;
  /**
   * Search visibility (P2/7), when the company has tracked keywords with at
   * least one measurement. Omitted entirely otherwise — an empty line reads as
   * "you rank nowhere", which we have not measured and cannot claim.
   */
  visibility?: { tracked: number; inTopTen: number; shareOfTopTen: number } | null;
}

/**
 * Screenshots as data URIs, read from disk by the caller.
 *
 * The PDF is rendered by headless Chrome in the worker, which has no session
 * and cannot pull /api/files. Inlining the bytes is what makes the images
 * appear at all — a src pointing at the app would render two broken boxes,
 * which is exactly how they came to be missing from the PDF.
 */
export interface InlineShots {
  desktop?: string | null;
  mobile?: string | null;
}

/**
 * Competitor side-by-side, named (P2/3).
 *
 * The sales PDF is ours. The public share page renders the anonymised version
 * of the same table — see anonymizeComparison — and never this one.
 */
function comparisonSection(table: ComparisonTable | null | undefined): string {
  if (!table || table.subjects.length < 2) return "";
  const head = table.subjects
    .map(
      (s, i) =>
        `<th>${esc(
          i === 0 ? "This site" : (s.name ?? s.url.replace(/^https?:\/\//, "").replace(/\/$/, "")),
        )}</th>`,
    )
    .join("");

  const rows = table.rows
    .map(
      (r) => `<tr>
        <td>${esc(r.en)}</td>
        ${r.values
          .map(
            (v, i) =>
              `<td class="num${i === 0 ? ` d-${r.direction}` : ""}">${v === null ? "&mdash;" : v}</td>`,
          )
          .join("")}
      </tr>`,
    )
    .join("");

  const takeaways = table.rows
    .map((r) => `<div class="muted">${esc(r.takeawayHu)}</div>`)
    .join("");

  return `
    <div class="eyebrow">Versenytárs-összehasonlítás</div>
    <table class="cmp">
      <thead><tr><th>Metric</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="takeaways">${takeaways}</div>
  `;
}

/** Shared report body (used by both the PDF and the public share page). */
export function auditReportBody(
  view: AuditView,
  shots: InlineShots = {},
  comparison: ComparisonTable | null = null,
): string {
  const flags = view.flags
    .map(
      (f) =>
        `<span class="tag">${esc(f)}</span>`,
    )
    .join("");

  // Grouped by category with a subscore each (P1/3d), so the reader sees
  // WHERE the site is weak rather than one number. Categories with nothing
  // measured are omitted entirely — printing "not measured" rows would pad the
  // report with our own gaps.
  const grouped = scoreByCategory(view.checks).filter((g) => g.total > 0);
  const checks = grouped
    .map(
      (g) => `
      <div class="cat">
        <div class="cat-head">
          <span class="cat-name">${esc(CATEGORY_LABEL[g.category].en)}</span>
          <span class="cat-score">${g.failed}/${g.total} issues</span>
        </div>
        ${g.checks
          .map(
            (c) => `
        <div class="check">
          <span class="ic ${c.pass ? "p" : "f"}">${c.pass ? "&#10003;" : "&#10007;"}</span>
          <span>${esc(c.label)}${c.detail ? ` <span class="muted">· ${esc(c.detail)}</span>` : ""}</span>
        </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");

  const otherChecks = ungroupedChecks(view.checks);
  const other =
    otherChecks.length === 0
      ? ""
      : `<div class="cat"><div class="cat-head"><span class="cat-name">Other</span></div>` +
        otherChecks
          .map(
            (c) =>
              `<div class="check"><span class="ic ${c.pass ? "p" : "f"}">${
                c.pass ? "&#10003;" : "&#10007;"
              }</span><span>${esc(c.label)}</span></div>`,
          )
          .join("") +
        `</div>`;

  const shotPairs: Array<[string, string | null | undefined]> = [
    ["Asztali nezet", shots.desktop],
    ["Mobil nezet", shots.mobile],
  ];
  const shotsHtml = shotPairs.some(([, src]) => src)
    ? '<div class="shots">' +
      shotPairs
        .filter(([, src]) => src)
        .map(
          ([label, src]) =>
            '<figure><img src="' + src + '" alt="' + esc(label) + '"/><figcaption>' +
            esc(label) + "</figcaption></figure>",
        )
        .join("") +
      "</div>"
    : "";

  const pitch = view.pitchSummary
    ? `<div class="pitch"><div class="eyebrow">Pitch angle</div><p>${esc(view.pitchSummary)}</p></div>`
    : "";

  return `
    <div class="hero">
      <div class="score">${view.score}</div>
      <div>
        <div class="verdict">${VERDICT_LABEL[view.verdict] ?? "Skip"}</div>
        <div class="muted url">${esc(view.url)}</div>
        <div class="flags">${flags}</div>
      </div>
    </div>
    ${speedSection(view)}
    <div class="eyebrow">Findings</div>
    <div class="checks">${checks}${other}</div>
    ${comparisonSection(comparison)}
    ${structureSection(view)}
    ${recommendedOrderSection(view)}
    ${shotsHtml}
    ${pitch}
  `;
}

/**
 * Lab score beside field data (P2/2).
 *
 * The lab number is one synthetic load; the field data is what real visitors
 * lived through over 28 days. Printing them side by side is what makes the
 * finding hard to wave away — and when there is no field data, saying so
 * plainly beats implying the site is fine.
 */
function speedSection(view: AuditView): string {
  const psi = view.checks.find((c) => c.key === "psiPerformance");
  const crux = view.crux ?? null;
  if (!psi && !crux) return "";

  const rows = crux
    ? ([
        ["Betöltés (LCP)", "lcp"],
        ["Válaszkészség (INP)", "inp"],
        ["Elrendezés (CLS)", "cls"],
      ] as const)
        .map(([label, key]) => {
          const m = crux[key];
          if (!m) return "";
          const v = verdictFor(key, m.p75);
          return `<tr>
            <td>${esc(label)}</td>
            <td class="num">${esc(formatMetric(key, m.p75))}</td>
            <td class="num">${Math.round(m.good * 100)}%</td>
            <td class="num">${Math.round(m.needsImprovement * 100)}%</td>
            <td class="num v-${v ?? "na"}">${Math.round(m.poor * 100)}%</td>
          </tr>`;
        })
        .join("")
    : "";

  const field = crux
    ? `<table class="crux">
         <thead><tr><th>Field data (28 days)</th><th>p75</th><th>good</th><th>needs work</th><th>poor</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
       <div class="muted scope">${esc(fieldSummaryEn(crux))}${
         crux.period ? ` · ${esc(crux.period)}` : ""
       } · ${crux.formFactor === "PHONE" ? "phone traffic" : "all devices"}</div>`
    : `<div class="muted scope">${esc(fieldSummaryEn(null))}</div>`;

  const lab = psi
    ? `<div class="lab"><b>Lab (PageSpeed)</b> <span class="muted">${esc(
        psi.detail ?? (psi.pass ? "pass" : "fail"),
      )}</span></div>`
    : "";

  return `<div class="eyebrow">Speed — lab vs. real visitors</div>${lab}${field}`;
}

/**
 * The closing "Javasolt sorrend" page (P2/4).
 *
 * Generated deterministically from the impact/effort registry — the same
 * ordering the internal matrix shows, printed as the one page a client keeps.
 * No AI: the sequence is a sort, not an opinion.
 */
function recommendedOrderSection(view: AuditView): string {
  const matrix = buildPriorityMatrix(view.checks);
  if (matrix.ordered.length === 0) return "";

  const groups = QUADRANTS.map((q) => {
    const bucket = matrix.quadrants.find((x) => x.id === q.id);
    if (!bucket || bucket.findings.length === 0) return "";
    const items = bucket.findings
      .map(
        (f) =>
          `<li>${esc(f.label)}${
            f.detail ? ` <span class="muted">· ${esc(f.detail)}</span>` : ""
          } <span class="eff">${esc(EFFORT_LABEL[f.effort].hu)}</span></li>`,
      )
      .join("");
    return `<div class="prio">
      <div class="prio-head">${esc(q.hu)} <span class="muted">— ${esc(q.note.hu)}</span></div>
      <ol>${items}</ol>
    </div>`;
  }).join("");

  return `<div class="page-break"></div>
    <div class="eyebrow">Javasolt sorrend</div>
    ${groups}`;
}

/**
 * Per-page detail from the crawl (P2/1) — the sales PDF only.
 *
 * The grouped findings above already carry the Site structure verdicts; this
 * is the evidence behind them, which is what makes the finding usable in a
 * conversation ("these four pages share one title, here they are").
 */
function structureSection(view: AuditView): string {
  const crawl = view.crawl;
  if (!crawl || crawl.pages.length === 0) return "";
  const { rows } = analyzeStructure(crawl);

  const kb = (b: number) => (b > 0 ? `${Math.round(b / 1000)} KB` : "—");
  const body = rows
    .map((r) => {
      const notes: string[] = [];
      if (r.titleDuplicate) notes.push("duplicate title");
      if (r.metaDuplicate) notes.push("duplicate meta");
      if (r.h1Count !== 1) notes.push(r.h1Count === 0 ? "no H1" : `${r.h1Count} H1s`);
      if (r.redirects.length >= 2) notes.push(`${r.redirects.length} redirects`);
      if (r.brokenLinksOut > 0) notes.push(`${r.brokenLinksOut} broken links`);
      if (r.weightOutlier) notes.push("heavy");
      if (r.deep?.a11y && r.deep.a11y.critical > 0) {
        notes.push(`${r.deep.a11y.critical} critical a11y`);
      }
      return `<tr>
        <td>${esc(r.path)}</td>
        <td class="num">${r.status ?? "—"}</td>
        <td>${esc(r.title ?? "—")}</td>
        <td class="num">${kb(r.bytes)}</td>
        <td class="muted">${esc(notes.join(", ") || "—")}</td>
      </tr>`;
    })
    .join("");

  const broken = crawl.brokenLinks.length
    ? `<div class="broken"><b>Broken links</b>${crawl.brokenLinks
        .slice(0, 12)
        .map(
          (b) =>
            `<div class="muted">${esc(pathOnly(b.from))} &rarr; ${esc(
              pathOnly(b.to),
            )} · ${b.status ?? "unreachable"}</div>`,
        )
        .join("")}${
        crawl.brokenLinks.length > 12
          ? `<div class="muted">+${crawl.brokenLinks.length - 12} more</div>`
          : ""
      }</div>`
    : "";

  // The mode belongs in the client-facing document too: 10 rendered pages and
  // 25 fetched ones are different depths of inspection, and "we crawled your
  // site" without saying which is a claim the reader cannot size.
  const modeLabel =
    crawl.mode === "rendered"
      ? " · rendered in a browser (JS-heavy site)"
      : crawl.mode === "static"
        ? " · static crawl"
        : "";
  const scope = `${crawl.pages.length} of ${crawl.discovered} pages crawled${modeLabel}${
    crawl.deadlineHit ? " · stopped on time budget" : ""
  }${crawl.robotsSkipped > 0 ? ` · ${crawl.robotsSkipped} skipped per robots.txt` : ""}`;

  return `
    <div class="eyebrow">Site structure</div>
    <div class="muted scope">${esc(scope)}</div>
    <table class="pages">
      <thead><tr><th>Page</th><th>Status</th><th>Title</th><th>HTML</th><th>Notes</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${broken}
  `;
}

function pathOnly(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export function buildAuditPdfHtml(
  view: AuditView,
  opts: AuditDocOptions & { shots?: InlineShots } = {},
): string {
  const brand = opts.brand ?? VENTURE_BRAND;
  const footerName = opts.brandName ?? brand.footerIdentity;
  const date = fmtDate(opts.generatedAt ?? new Date());
  const gradient = brandGradient(brand);
  // A logo replaces the wordmark entirely; the worker inlines it as a data URI
  // for the same reason the screenshots are inlined — headless Chrome has no
  // session and would render an app URL as a broken box.
  const mark = brand.logoUrl
    ? `<img class="logo" src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}"/>`
    : `<b>${esc(brand.markBold)}</b>${brand.markLight ? `<span>${esc(brand.markLight)}</span>` : ""}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  .cat { margin-top: 14px; break-inside: avoid; }
  .cat-head {
    display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px;
    border-bottom: 1px solid rgba(239,241,248,0.09); margin-bottom: 6px;
  }
  .cat-name { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
  .cat-score { margin-left: auto; font-size: 10px; color: var(--brand-muted); }
  .shots { display: flex; gap: 12px; margin-top: 18px; }
  .shots figure { flex: 1; min-width: 0; }
  .shots img {
    width: 100%; height: 150px; object-fit: cover; object-position: top;
    border: 1px solid rgba(239,241,248,0.09); border-radius: 10px;
  }
  .shots figcaption {
    margin-top: 4px; text-align: center; font-size: 9px; color: var(--brand-muted);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--brand-canvas); color: var(--brand-ink); padding: 48px 44px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .brand { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 4px; }
  .logo { max-height: 34px; max-width: 220px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: var(--brand-muted); margin-left: 6px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--brand-muted); margin-bottom: 34px; }
  .hero { display: flex; align-items: center; gap: 24px; padding: 22px 0 26px; border-bottom: 1px solid rgba(239,241,248,0.09); }
  .score {
    font-size: 76px; font-weight: 800; letter-spacing: -0.03em; line-height: 1;
    background: ${gradient}; -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .verdict { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .url { font-size: 12px; }
  .muted { color: var(--brand-muted); }
  .flags { margin-top: 10px; }
  .tag {
    display: inline-block; font-size: 11px; font-weight: 700; color: var(--brand-ink);
    background: ${gradient}; border-radius: 20px; padding: 3px 10px; margin: 0 4px 4px 0;
  }
  .eyebrow { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brand-muted); margin: 26px 0 12px; }
  .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
  .check { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--brand-ink-soft); }
  .ic { display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; font-size: 10px; }
  .ic.p { background: rgba(61,220,151,0.15); color: #3DDC97; }
  .ic.f { background: rgba(255,92,122,0.15); color: #FF5C7A; }
  .scope { font-size: 10px; margin: -6px 0 8px; }
  .lab { font-size: 11px; margin-bottom: 6px; }
  .crux { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 4px; }
  .crux th {
    text-align: right; font-size: 9px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--brand-muted); border-bottom: 1px solid rgba(239,241,248,0.09); padding: 4px 6px 4px 0;
  }
  .crux th:first-child, .crux td:first-child { text-align: left; }
  .crux td {
    padding: 4px 6px 4px 0; color: var(--brand-ink-soft); text-align: right;
    border-bottom: 1px solid rgba(239,241,248,0.05); font-variant-numeric: tabular-nums;
  }
  .crux td.v-poor { color: #FF5C7A; }
  .crux td.v-needs-improvement { color: #F5B841; }
  .pages { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
  .pages th {
    text-align: left; font-size: 9px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--brand-muted); border-bottom: 1px solid rgba(239,241,248,0.09); padding: 4px 6px 4px 0;
  }
  .pages td {
    padding: 4px 6px 4px 0; color: var(--brand-ink-soft); vertical-align: top;
    border-bottom: 1px solid rgba(239,241,248,0.05);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pages td.num { font-variant-numeric: tabular-nums; }
  .pages th:nth-child(2), .pages td:nth-child(2) { width: 48px; }
  .pages th:nth-child(4), .pages td:nth-child(4) { width: 56px; }
  .pages th:nth-child(5), .pages td:nth-child(5) { width: 150px; white-space: normal; }
  .cmp { width: 100%; border-collapse: collapse; font-size: 11px; }
  .cmp th {
    text-align: right; font-size: 9px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--brand-muted); border-bottom: 1px solid rgba(239,241,248,0.09); padding: 4px 6px 4px 0;
  }
  .cmp th:first-child, .cmp td:first-child { text-align: left; }
  .cmp td {
    padding: 5px 6px 5px 0; color: var(--brand-ink-soft); text-align: right;
    border-bottom: 1px solid rgba(239,241,248,0.05); font-variant-numeric: tabular-nums;
  }
  .cmp td.d-better { color: #3DDC97; font-weight: 700; }
  .cmp td.d-worse { color: #FF5C7A; font-weight: 700; }
  .takeaways { margin-top: 8px; font-size: 10.5px; line-height: 1.7; }
  .page-break { break-before: page; height: 0; }
  .prio { margin-bottom: 14px; break-inside: avoid; }
  .prio-head { font-size: 11px; font-weight: 700; margin-bottom: 4px; }
  .prio ol { margin: 0 0 0 16px; padding: 0; }
  .prio li { font-size: 11px; color: var(--brand-ink-soft); margin-bottom: 3px; }
  .eff {
    font-size: 9px; color: var(--brand-muted); border: 1px solid rgba(239,241,248,0.12);
    border-radius: 10px; padding: 1px 6px; margin-left: 4px;
  }
  .broken { margin-top: 10px; font-size: 10px; }
  .broken b { display: block; margin-bottom: 3px; font-size: 10px; }
  .pitch { margin-top: 26px; border: 1px solid ${brand.color}66; background: ${brand.color}1A; border-radius: 12px; padding: 16px 18px; }
  .pitch p { font-size: 12.5px; line-height: 1.6; color: var(--brand-accent-ink); }
  .foot { margin-top: 40px; padding-top: 14px; border-top: 1px solid rgba(239,241,248,0.09); font-size: 10.5px; color: var(--brand-muted); }
</style></head>
<body style="${brandRootStyle(brand)}">
  <div class="brand">${mark}</div>
  <div class="kicker">Website Opportunity Audit</div>
  ${auditReportBody(view, opts.shots ?? {}, opts.comparison ?? null)}
  ${
    opts.visibility && opts.visibility.tracked > 0
      ? `<div class="eyebrow">Keresési láthatóság</div><div class="muted scope">${
          opts.visibility.tracked
        } követett kulcsszóból ${opts.visibility.inTopTen} van a Google első tíz találata között (${
          opts.visibility.shareOfTopTen
        }%).</div>`
      : ""
  }
  <div class="foot">Prepared by ${esc(footerName)} · ${date} · High score = weak site = strong opportunity.</div>
</body></html>`;
}
