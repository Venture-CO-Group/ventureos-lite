"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt, attemptData } from "@/lib/client/server-action";
import { lookupTaxpayer } from "@/modules/registry/actions";
import { lookupCompanySite } from "@/modules/leads/site-lookup";
import { verifyLeadEmail } from "@/modules/verification/actions";
import { runResearch } from "@/modules/leads/actions";
import type { Stage } from "@prisma/client";
import {
  getLeadDetail,
  overrideScoreFromDetail,
  updateLeadDetail,
  type LeadDetail,
} from "@/modules/leads/detail";
import { moveLeadStage, deleteLead } from "@/modules/leads/actions";
import {
  convertLeadToDeal,
  getDealsForLead,
  type LeadDealLink,
} from "@/modules/deals/actions";
import { PIPELINE_STAGES, SIDE_STAGES, STAGE_LABELS } from "@/modules/pipeline/transitions";
import { DEAL_OWNED_LEAD_STAGES } from "@/modules/deals/pipelines";
import { setQualification } from "@/modules/inbox/actions";
import {
  QUAL_ITEMS,
  QUAL_LABEL,
  QUALIFY_THRESHOLD,
  answeredCount,
  type QualItem,
} from "@/modules/inbox/qualification";
import { LeadAvatar } from "./lead-avatar";
import { CustomFieldsEditor } from "./custom-fields-editor";
import { CaptureDiagnosticsPanel } from "./capture-diagnostics";
import { SearchVisibility } from "./search-visibility";
import { duplicatesForLead } from "@/modules/merge/actions";
import { Modal } from "./modal";
import { InlineField, type InlineSaveResult, type InlineValue } from "./inline-edit";
import { StarToggle } from "./star-toggle";
import { editLeadDetailField } from "@/modules/leads/detail-inline-actions";
import { EntityTasks } from "./entity-tasks";

const INLINE_HINT =
  "Corrected in place — each change saves as you leave the field.";

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45";

/**
 * Pipeline card detail. Opens from a card click; every field saves through a
 * server action that revalidates its own inputs, so the modal is a convenience
 * rather than the trust boundary.
 */
export function LeadDetailModal({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /** Open tasks on this lead, for the header badge (playbook-v5 P20/4). */
  const [openTasks, setOpenTasks] = useState(0);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // editable copy
  const [form, setForm] = useState<LeadDetail | null>(null);
  const [signalInput, setSignalInput] = useState("");
  const [scoreReason, setScoreReason] = useState("");
  const [scoreDraft, setScoreDraft] = useState<number | null>(null);
  // Two-step delete. This is a hard erasure across a dozen tables plus files
  // on disk with no undo, so it does not hang off a single click.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [erasingDocs, setErasingDocs] = useState(false);
  // The money side of this lead (P4/b). Loaded alongside the detail so the
  // modal can say "this became a deal" instead of leaving the two apart.
  const [deals, setDeals] = useState<LeadDealLink[] | null>(null);
  // "Possible duplicate" (P5/2). Computed on demand: a duplicate is a
  // relationship between two rows, and a stored flag on one goes stale the
  // moment the other is edited.
  const [duplicates, setDuplicates] = useState<
    Array<{ id: string; label: string; detail: string; confidence: number }>
  >([]);

  useEffect(() => {
    let live = true;
    getLeadDetail(leadId)
      .then((d) => {
        if (!live) return;
        if (!d) {
          setLoadError(true);
          return;
        }
        setDetail(d);
        setForm(d);
        setScoreDraft(d.icpScore);
      })
      .catch(() => live && setLoadError(true));
    getDealsForLead(leadId)
      .then((d) => live && setDeals(d))
      .catch(() => live && setDeals([]));
    duplicatesForLead(leadId)
      .then((d) => live && setDuplicates(d))
      .catch(() => live && setDuplicates([]));
    return () => {
      live = false;
    };
  }, [leadId]);

  function patch(next: Partial<LeadDetail>) {
    setForm((f) => (f ? { ...f, ...next } : f));
  }

  /**
   * One field, committed on the spot (playbook-v5 P16/1).
   *
   * ── WHY ONLY SOME OF THIS PANEL IS INLINE ───────────────────────────────
   *
   * The fields below the Contact block are edited one at a time to correct a
   * fact, and inline is right for them. The COMPANY BLOCK, the email and the
   * phone are not: `lookupTaxId` fills them from NAV's register and
   * `lookupDomain` from a Claude web search that SPENDS MONEY, and both do it
   * as a suggestion the operator reviews. "Press Save changes to keep it" is
   * the human-review gate on machine-suggested data — the same principle as
   * the outreach guardrail — and per-field auto-commit would remove it, taking
   * NAV's spelling of a company name without anybody agreeing to it.
   *
   * So those keep the Save button, and the panel says which is which.
   */
  async function commitInline(field: string, value: InlineValue): Promise<InlineSaveResult> {
    if (!form) return { ok: false, error: "Lead not loaded." };
    /**
     * Through `attempt`, not returned bare.
     *
     * Next redacts anything THROWN out of a Server Action, so an unexpected
     * failure arrives as an Error with only a digest — no message. A bare
     * `return action(...)` leaves that rejection uncaught: the cell stays in
     * its saving state for ever, shows nothing, and keeps the edit. Expected
     * refusals were always returned as data; this is the net under the rest,
     * and test/unit/server-action-silence.test.ts is what noticed it was
     * missing here.
     */
    const res = await attempt(editLeadDetailField({ leadId: form.id, field, value }));
    if (res.ok) {
      // Keep local state in step so a later Save does not post a stale value
      // back over what was just committed.
      patch({ [field]: ("value" in res ? res.value : null) ?? "" } as Partial<LeadDetail>);
    }
    return res as InlineSaveResult;
  }

  function remove() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(deleteLead({ leadId: form.id, eraseDocuments: erasingDocs }));
      if (!res.ok) {
        setConfirmDelete(false);
        setMsg({ kind: "err", text: res.error });
        return;
      }
      // The lead no longer exists, so the modal must go before anything tries
      // to re-read it; refresh so the list it was opened from drops the row.
      onClose();
      router.refresh();
    });
  }

  /**
   * Fill the company from NAV's register.
   *
   * Only ever overwrites a field the operator LEFT EMPTY — except the name,
   * where NAV's spelling is the authoritative one and is offered explicitly.
   * Nothing is saved here: the fields are filled and Save changes still has to
   * be pressed, so a wrong number is one Cancel away from being undone.
   */
  function lookupTaxId() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(lookupTaxpayer(form.companyTaxId));
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      patch({
        companyName: res.legalName,
        companyCity: res.city ?? form.companyCity,
        companyTaxId: res.taxNumber,
      });
      const notes = [
        res.deregistered ? "NAV says this taxpayer is DEREGISTERED." : null,
        res.vatGroupMembership ? `VAT group member: ${res.vatGroupMembership}.` : null,
        res.address,
      ].filter(Boolean);
      setMsg({
        kind: res.deregistered ? "err" : "ok",
        text: `${res.legalName}${notes.length ? ` — ${notes.join(" ")}` : ""} Press Save changes to keep it.`,
      });
    });
  }

  /**
   * Fill the company's website — and what is on it — from the Domain field.
   *
   * With a domain typed in, this reads the site and nothing else: no model
   * call, no cost. With the field empty it asks Claude to search the web for
   * the company's own site, which is the one case where a click spends money,
   * so the button says so in its tooltip before it is pressed.
   *
   * Same discipline as the adószám lookup: only ever fills a field the operator
   * LEFT EMPTY, and saves nothing — Save changes is still a deliberate press.
   */
  function lookupDomain() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(
        lookupCompanySite({
          leadId: form.id,
          domain: form.companyDomain,
          companyName: form.companyName,
          city: form.companyCity,
          taxId: form.companyTaxId,
        }),
      );
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }

      const filled: string[] = [];
      if (res.domain !== form.companyDomain.trim()) filled.push("domain");
      const email = form.email.trim() ? form.email : (res.emails[0] ?? "");
      const phone = form.phone.trim() ? form.phone : (res.phones[0] ?? "");
      if (email !== form.email) filled.push("email");
      if (phone !== form.phone) filled.push("phone");
      patch({ companyDomain: res.domain, email, phone });

      const found =
        res.source === "web_search"
          ? `Found ${res.domain} (${res.confidence} confidence)${res.reason ? ` — ${res.reason}` : ""}`
          : `Read ${res.domain}`;
      const parts = [
        found,
        res.siteNote ? `The site gave nothing: ${res.siteNote}.` : null,
        filled.length > 0
          ? `Filled: ${filled.join(", ")}. Press Save changes to keep it.`
          : "Nothing new to fill in.",
      ].filter(Boolean);
      setMsg({ kind: "ok", text: parts.join(" ") });
    });
  }

  /**
   * Check the address before it costs the sending domain anything.
   *
   * The same layered check the cold-campaign gate runs — spelling, throwaway
   * domain, role address, MX record — so the answer here is the answer the gate
   * will give, not a second opinion from a second code path. Verifies the SAVED
   * address: a freshly typed one has to be saved first, which the message says.
   */
  function verifyEmail() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(verifyLeadEmail({ leadId: form.id, force: true }));
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      const label =
        res.status === "valid"
          ? "Deliverable"
          : res.status === "risky"
            ? "Risky"
            : res.status === "invalid"
              ? "Not deliverable"
              : "Could not tell";
      setMsg({
        kind: res.status === "invalid" ? "err" : "ok",
        text: `${label} — ${res.message}`,
      });
    });
  }

  /**
   * Something to go on: either a domain to read, or a name to search for.
   * Two characters is the shortest name a search could mean anything with.
   */
  const canLookupDomain =
    (form?.companyDomain ?? "").trim().length > 0 ||
    (form?.companyName ?? "").trim().length >= 2;

  /**
   * The domain the audit should run against.
   *
   * The company domain is the useful one; a lead's own LinkedIn URL is not a
   * site worth auditing, so it is deliberately not a fallback.
   */
  const auditTarget = (form?.companyDomain ?? "").trim();

  /**
   * A deal starts where the lead's journey ends (P4/a), so the conversion is
   * refused below Qualified — correctly, and it said so. It said so AFTER the
   * click, though, which is the one thing the button beside it does not do: the
   * audit is disabled with the reason on it when there is no domain. Offering a
   * control that answers "no" is how a working refusal reads as a broken button.
   */
  const canConvertToDeal = !!detail && DEAL_OWNED_LEAD_STAGES.includes(detail.stage as Stage);

  /**
   * Saved on the spot rather than on Save changes, deliberately: this is the
   * one control here whose only purpose is to unlock the button underneath it,
   * and a checkbox that needs a second press elsewhere to count would be the
   * same dead end in a new place.
   */
  function toggleQual(item: QualItem, value: boolean) {
    if (!form || !detail) return;
    setMsg(null);
    // The tick moves NOW. Waiting for the round trip meant a click that changed
    // nothing on screen for as long as the server took — the exact appearance of
    // a dead control. The server's answer replaces this, and a failure puts it
    // back where it was and says so.
    const before = detail.qualification;
    setDetail((d) => (d ? { ...d, qualification: { ...d.qualification, [item]: value } } : d));
    startTransition(async () => {
      const res = await attemptData(setQualification({ leadId: form.id, item, value }));
      if (!res.ok) {
        setDetail((d) => (d ? { ...d, qualification: before } : d));
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setDetail((d) => (d ? { ...d, qualification: res.data.qualification } : d));
    });
  }

  /** Research from the modal — the table only offers it before a score exists. */
  function runResearchHere() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(runResearch(form.id));
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setDetail((d) => (d ? { ...d, icpScore: res.icpScore } : d));
      setMsg({ kind: "ok", text: `Researched — ICP score ${res.icpScore}.` });
      router.refresh();
    });
  }

  function save() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      /**
       * `attempt`, not a bare await. Every REFUSAL here already comes back as
       * `{ ok: false, error }`, but an unexpected throw is redacted by Next.js
       * to a message-less Error — and an unhandled rejection inside a transition
       * shows the operator nothing whatsoever. "The save does not work" was that
       * silence, not a dead button.
       */
      const res = await attempt(
        updateLeadDetail({
          leadId: form.id,
          contactName: form.contactName,
          title: form.title,
          headline: form.headline,
          locationRaw: form.locationRaw,
          email: form.email,
          phone: form.phone,
          linkedinUrl: form.linkedinUrl,
          language: form.language,
          notes: form.notes,
          signals: form.signals,
          company: {
            name: form.companyName,
            domain: form.companyDomain,
            city: form.companyCity,
            taxId: form.companyTaxId,
          },
        }),
      );
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setMsg({ kind: "ok", text: "Saved." });
      router.refresh();
    });
  }

  if (loadError) {
    return (
      <Modal onClose={onClose}>
        <p className="text-[13px] text-[#FFB3C2]" data-testid="lead-modal-error">
          That lead is not available in this workspace.
        </p>
        <div className="mt-3 flex justify-end">
          <button type="button" className={BTN} onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  if (!form || !detail) {
    return (
      <Modal onClose={onClose}>
        <p className="text-[13px] text-muted">Loading…</p>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="lead-modal-title" wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LeadAvatar name={form.contactName} path={detail.avatarPath} size={40} />
        <h3 id="lead-modal-title" className="font-display text-lg font-bold lowercase">
          {form.contactName || form.companyName || "lead"}
        </h3>
        {/* Open work, on the header, where it is seen before anything else. */}
        {openTasks > 0 && (
          <span
            data-testid="entity-header-task-badge"
            title={`${openTasks} open task${openTasks === 1 ? "" : "s"}`}
            className="rounded-full border border-accent-soft px-2 py-0.5 text-[11px] tabular-nums text-accent-ink"
          >
            ☑ {openTasks}
          </span>
        )}
        {/**
         * The star also records the visit (playbook-v5 P17/2) — mounting it
         * means somebody is looking at this lead, which is exactly when a
         * "recent" becomes true, and it keeps the write off the render path.
         */}
        <StarToggle
          entityType="lead"
          entityId={form.id}
          label={form.contactName || form.companyName || "Lead"}
          href={`/leads?lead=${form.id}`}
        />
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
          {STAGE_LABELS[detail.stage as Stage] ?? detail.stage} · {detail.daysInStage}d
        </span>
        <span className="text-[11px] text-muted">{detail.source.toLowerCase()}</span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="lead-modal-message"
          className={`mb-3 rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* Possible duplicate (P5/2). A banner, not a block: the two records may
          genuinely be two people, and only a person can tell. */}
      {duplicates.length > 0 && (
        <section
          className="mb-3 rounded-[11px] border border-[rgba(255,176,66,0.4)] bg-[rgba(255,176,66,0.08)] p-3"
          data-testid="duplicate-banner"
        >
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-warn">
            Possible duplicate
          </p>
          <ul className="grid gap-1">
            {duplicates.map((d) => (
              <li key={d.id} className="text-[12.5px] text-[#C9CEE3]">
                {d.detail}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] text-muted">
            Compare and merge them in Settings → Data quality.
          </p>
        </section>
      )}

      {/* The capture brief: written once by Haiku from the About text and the
          person's recent posts, cached on the lead. It was being generated and
          paid for since P1/1e without ever being shown. */}
      {detail.personBrief && (
        <section
          className="mb-3 rounded-[11px] border border-accent-soft bg-accent-soft p-3"
          data-testid="lead-person-brief"
        >
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-ink">
            From the captured profile
          </p>
          <p className="text-[12.5px] leading-relaxed text-[#C9CEE3]">{detail.personBrief}</p>
          {detail.bio && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11.5px] text-muted">About text</summary>
              <p className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-muted">
                {detail.bio}
              </p>
            </details>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* ---------- editable fields ---------- */}
        <div className="grid gap-3">
          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Contact</p>
            <p className="text-[11px] text-muted">{INLINE_HINT}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <span data-testid="lead-name">
                <InlineField
                  kind="text"
                  label="Name"
                  placeholder="Name"
                  value={form.contactName}
                  display={form.contactName}
                  onSave={(next) => commitInline("contactName", next)}
                />
              </span>
              <span data-testid="lead-title">
                <InlineField
                  kind="text"
                  label="Job title"
                  placeholder="Job title"
                  value={form.title}
                  display={form.title}
                  onSave={(next) => commitInline("title", next)}
                />
              </span>
              {/*
                THE HEADLINE HAS ITS OWN INPUT.
                It used to share the job-title one, because the capture wrote
                `title: jobTitle ?? headline`. So a profile with no Experience
                section — most of them, since the section is lazy-rendered — showed
                its headline where its job title belongs. They are different facts:
                a job title is "VP Sales", a headline is "VP Sales @ Metaview |
                Startup Advisor and Investor | Ramp and Navan Alum".
              */}
              <span className="sm:col-span-2" data-testid="lead-headline">
                <InlineField
                  kind="text"
                  label="Headline"
                  placeholder="Headline"
                  value={form.headline}
                  display={form.headline}
                  onSave={(next) => commitInline("headline", next)}
                />
              </span>
              <div className="flex gap-1.5">
                <input
                  className={INPUT}
                  placeholder="Email"
                  data-testid="lead-email"
                  value={form.email}
                  onChange={(e) => patch({ email: e.target.value })}
                />
                {/*
                  Checks the SAVED address, not the one being typed — the whole
                  point is what a mail server will do with what we hold.
                */}
                <button
                  type="button"
                  className={BTN}
                  data-testid="lead-verify-email"
                  disabled={pending || form.email.trim().length === 0}
                  title="Check whether this address can receive mail"
                  onClick={verifyEmail}
                >
                  Verify
                </button>
              </div>
              <input
                className={INPUT}
                placeholder="Phone"
                value={form.phone}
                onChange={(e) => patch({ phone: e.target.value })}
              />
              {/*
                THE PROFILE'S OWN LOCATION.
                Captured on every profile and previously shown nowhere: the only
                City input on this form belongs to the company, so a lead without
                a company displayed no location at all — even though it had been
                read correctly and stored. It sits in the Contact block because it
                describes the PERSON, not their employer.
              */}
              <span data-testid="lead-location">
                <InlineField
                  kind="text"
                  label="Location"
                  placeholder="Location"
                  value={form.locationRaw}
                  display={form.locationRaw}
                  onSave={(next) => commitInline("locationRaw", next)}
                />
              </span>
              <span className="sm:col-span-2">
                <InlineField
                  kind="text"
                  label="LinkedIn URL"
                  placeholder="LinkedIn URL"
                  value={form.linkedinUrl}
                  display={form.linkedinUrl}
                  onSave={(next) => commitInline("linkedinUrl", next)}
                />
              </span>
              <label className="flex items-center gap-2 text-[12px] text-muted">
                Language
                <select
                  className={INPUT}
                  data-testid="lead-language"
                  value={form.language}
                  onChange={(e) => patch({ language: e.target.value as "HU" | "EN" })}
                >
                  <option value="HU">Hungarian</option>
                  <option value="EN">English</option>
                </select>
              </label>
            </div>
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Company</p>
            {/**
             * Said out loud, because this block behaves differently from the
             * one above it. The two lookups FILL these fields as a suggestion —
             * one from NAV's register, one from a Claude web search that costs
             * money — and the deliberate Save is what accepts them. Auto-saving
             * each field would take NAV's spelling of a company name without
             * anybody agreeing to it.
             */}
            <p className="text-[11px] text-muted">
              Filled by the lookups below — review, then press Save changes to keep it.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className={INPUT}
                placeholder="Company name"
                data-testid="lead-company"
                value={form.companyName}
                onChange={(e) => patch({ companyName: e.target.value })}
              />
              <div className="flex gap-1.5">
                <input
                  className={INPUT}
                  placeholder="Domain"
                  data-testid="lead-company-domain"
                  value={form.companyDomain}
                  onChange={(e) => patch({ companyDomain: e.target.value })}
                />
                {/*
                  Read the site, or find it. With a domain present this is a
                  plain fetch; with the field empty it is a web search, which
                  costs — hence the two different tooltips.
                */}
                <button
                  type="button"
                  className={BTN}
                  data-testid="lead-domain-lookup"
                  disabled={pending || !canLookupDomain}
                  title={
                    form.companyDomain.trim()
                      ? "Read this site and fill in what it says"
                      : "Search the web for this company's site (uses Claude)"
                  }
                  onClick={lookupDomain}
                >
                  Lookup
                </button>
              </div>
              <input
                className={INPUT}
                placeholder="City"
                data-testid="lead-city"
                value={form.companyCity}
                onChange={(e) => patch({ companyCity: e.target.value })}
              />
              <div className="flex gap-1.5">
                <input
                  className={INPUT}
                  placeholder="Adószám"
                  data-testid="lead-company-taxid"
                  value={form.companyTaxId}
                  onChange={(e) => patch({ companyTaxId: e.target.value })}
                />
                {/*
                  Look the number up at NAV and fill the company from the answer.
                  The whole lookup already existed — validator, signed request,
                  parser, credential resolver — with no button anywhere. It is
                  read-only (queryTaxpayer), free, and the name it returns is
                  NAV's own spelling, which is the one a contract has to carry.
                */}
                <button
                  type="button"
                  className={BTN}
                  data-testid="lead-taxid-lookup"
                  disabled={pending || form.companyTaxId.trim().length === 0}
                  title="Look this adószám up at NAV"
                  onClick={lookupTaxId}
                >
                  Lookup
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted">
              These apply to the company record, shared by every lead there.
            </p>

            {/*
              Keyword rank tracking (P2/7). The whole feature was built — the
              provider, the weekly job, the history, the sparkline — and the
              component was mounted nowhere, so every position it recorded was
              written and never seen. A company's own page is where it belongs.
            */}
            {form.companyId && <SearchVisibility companyId={form.companyId} />}
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Signals &amp; tags</p>
            <div className="flex flex-wrap gap-1.5">
              {form.signals.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted"
                >
                  {s}
                  <button
                    type="button"
                    aria-label={`Remove ${s}`}
                    className="text-muted hover:text-ink"
                    onClick={() => patch({ signals: form.signals.filter((x) => x !== s) })}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {form.signals.length === 0 && (
                <span className="text-[11.5px] text-muted">None yet.</span>
              )}
            </div>
            <input
              className={INPUT}
              placeholder="Add a signal and press Enter"
              data-testid="lead-signal-input"
              value={signalInput}
              onChange={(e) => setSignalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = signalInput.trim();
                if (!v || form.signals.includes(v)) return;
                patch({ signals: [...form.signals, v] });
                setSignalInput("");
              }}
            />
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Notes</p>
            <textarea
              className={`${INPUT} min-h-[90px] resize-y`}
              placeholder="Anything worth remembering"
              data-testid="lead-notes"
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </section>

          {confirmDelete && (
            <div
              className="rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] p-3.5"
              data-testid="lead-delete-confirm"
            >
              <p className="text-[12.5px] font-semibold text-[#FFB3C2]">
                Delete {form.contactName || "this lead"} permanently?
              </p>
              <p className="mt-1 text-[12px] text-muted">
                Removes the lead and everything derived from it — activities,
                messages, calls, meetings, email history, audit shares and
                campaign membership. This cannot be undone from the app, and
                backups age out within 14 days.
              </p>
              <label className="mt-2.5 flex items-center gap-2 text-[12px] text-[#C9CEE3]">
                <input
                  type="checkbox"
                  checked={erasingDocs}
                  onChange={(e) => setErasingDocs(e.target.checked)}
                  data-testid="lead-delete-docs"
                />
                Also delete issued quotes, contracts and certificates with their
                PDFs. Leave unticked to keep them for accounting, detached from
                the person.
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={BTN}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  data-testid="lead-delete-confirmed"
                  disabled={pending}
                  className="rounded-[10px] border border-[rgba(255,92,122,0.5)] bg-[rgba(255,92,122,0.12)] px-3.5 py-2 text-[12.5px] font-semibold text-[#FFB3C2] hover:bg-[rgba(255,92,122,0.2)] disabled:opacity-60"
                  onClick={remove}
                >
                  Delete permanently
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              data-testid="lead-delete"
              className="mr-auto rounded-[10px] border border-line px-3.5 py-2 text-[12.5px] text-[#FF8FA5] hover:border-[rgba(255,92,122,0.5)] hover:bg-[rgba(255,92,122,0.08)]"
              onClick={() => setConfirmDelete(true)}
            >
              Delete lead
            </button>
            <button type="button" className={BTN} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              data-testid="lead-save"
              disabled={pending}
              onClick={save}
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>

        {/* ---------- score, stage, timeline ---------- */}
        <div className="grid content-start gap-3">
          {/*
            Enrichment, for a lead that already exists.
            Both of these were reachable only at the moment of capture: research
            from the leads table and ONLY while the lead had no score yet, and
            the audit from its own page with the domain typed in by hand. So an
            existing lead could not be re-researched or audited at all from here.
          */}
          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Enrichment</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={BTN}
                data-testid="lead-run-research"
                disabled={pending}
                title="Re-read the profile and the company site, then re-score"
                onClick={runResearchHere}
              >
                {detail.icpScore == null ? "Run research" : "Re-run research"}
              </button>
              <button
                type="button"
                className={BTN}
                data-testid="lead-run-audit"
                disabled={pending || !auditTarget}
                title={
                  auditTarget
                    ? `Audit ${auditTarget}`
                    : "Add a company domain or a website first"
                }
                onClick={() => {
                  if (!auditTarget) return;
                  // The audit runs for ~30s with its own progress view, so it
                  // belongs on the audit page rather than inside a modal. `run=1`
                  // starts it on arrival — the operator already asked for it.
                  router.push(`/audit?url=${encodeURIComponent(auditTarget)}&run=1`);
                }}
              >
                Audit site
              </button>
            </div>
            {!auditTarget && (
              <p className="text-[11px] text-muted">
                The audit needs a domain. Fill in the company&apos;s domain and save.
              </p>
            )}
          </section>
          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>ICP score</p>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: form.maxScore + 1 }, (_, i) => i).map((n) => (
                <button
                  key={n}
                  type="button"
                  data-testid={`lead-score-${n}`}
                  onClick={() => setScoreDraft(n)}
                  className={`h-8 w-8 rounded-[8px] border text-[12.5px] font-semibold ${
                    scoreDraft === n
                      ? "border-accent bg-accent-soft text-[#E4D3FF]"
                      : "border-line bg-panel text-ink"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            {scoreDraft !== detail.icpScore && (
              <>
                <input
                  className={INPUT}
                  placeholder="Why? (recorded in the audit log)"
                  data-testid="lead-score-reason"
                  value={scoreReason}
                  onChange={(e) => setScoreReason(e.target.value)}
                />
                <button
                  type="button"
                  className={BTN}
                  data-testid="lead-score-save"
                  disabled={pending || scoreReason.trim().length < 3}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await attempt(
                        overrideScoreFromDetail({
                          leadId: form.id,
                          score: scoreDraft ?? 0,
                          reason: scoreReason,
                        }),
                      );
                      if (!res.ok) {
                        setMsg({ kind: "err", text: res.error });
                        return;
                      }
                      setDetail({ ...detail, icpScore: res.icpScore });
                      setScoreReason("");
                      setMsg({ kind: "ok", text: `Score set to ${res.icpScore}.` });
                      router.refresh();
                    })
                  }
                >
                  Save score override
                </button>
              </>
            )}
          </section>

          {/*
            THE GATE THAT COULD NOT BE OPENED.

            "Qualified" needs 3 of the 4 answers, enforced server-side — and the
            only place to give them was the Inbox, inside a thread. A lead
            qualified on the telephone, or one straight out of the Prospector,
            has no thread at all, so the stage button refused it forever and
            named a checklist the operator could not reach. The answers were
            always stored on the LEAD; only the UI was in the wrong room.
          */}
          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Qualification</p>
            <div className="grid gap-1.5">
              {QUAL_ITEMS.map((item) => (
                <label
                  key={item}
                  className="flex cursor-pointer items-center gap-2 text-[12px] text-ink"
                >
                  <input
                    type="checkbox"
                    data-testid={`lead-qual-${item}`}
                    className="h-3.5 w-3.5 accent-accent"
                    disabled={pending}
                    checked={!!detail.qualification[item]}
                    onChange={(e) => toggleQual(item, e.target.checked)}
                  />
                  {QUAL_LABEL[item]}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted">
              {answeredCount(detail.qualification)} of {QUAL_ITEMS.length} answered ·{" "}
              {QUALIFY_THRESHOLD} needed to move to Qualified.
            </p>
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Stage</p>
            <div className="flex flex-wrap gap-1.5">
              {[...PIPELINE_STAGES, ...SIDE_STAGES]
                .filter((s) => s !== detail.stage)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={BTN}
                    data-testid={`lead-stage-${s}`}
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const res = await attempt(moveLeadStage(form.id, s as Stage));
                        if (!res.ok) {
                          setMsg({ kind: "err", text: res.error });
                          return;
                        }
                        setDetail({ ...detail, stage: s });
                        setMsg({ kind: "ok", text: `Moved to ${STAGE_LABELS[s as Stage]}.` });
                        router.refresh();
                      })
                    }
                  >
                    {STAGE_LABELS[s as Stage] ?? s}
                  </button>
                ))}
            </div>
            {detail.stageReason && (
              <p className="text-[11.5px] text-muted">Reason: {detail.stageReason}</p>
            )}
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Fields</p>
            <CustomFieldsEditor
              entity="lead"
              entityId={detail.id}
              defs={detail.customFieldDefs}
              values={detail.customFieldValues}
            />
            {/* Collapsed unless the lead came from the extension. The evidence
                for "why is this field empty" belongs with the lead, not in a
                popup that has already closed. */}
            <CaptureDiagnosticsPanel leadId={detail.id} />
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Deals</p>
            {deals === null ? (
              <p className="text-[12px] text-muted">Loading…</p>
            ) : deals.length === 0 ? (
              <>
                <p className="text-[12px] text-muted">
                  No deal yet. A lead carries the conversation; a deal carries the money.
                </p>
                <button
                  type="button"
                  className={BTN}
                  data-testid="convert-to-deal"
                  disabled={pending || !canConvertToDeal}
                  title={
                    canConvertToDeal
                      ? "Create a deal from this lead"
                      : "Only a qualified lead becomes a deal"
                  }
                  onClick={() =>
                    startTransition(async () => {
                      const res = await attempt(convertLeadToDeal({ leadId: form.id }));
                      if (!res.ok) {
                        setMsg({ kind: "err", text: res.error });
                        return;
                      }
                      setDeals(await getDealsForLead(form.id));
                      setMsg({ kind: "ok", text: "Deal created." });
                      router.refresh();
                    })
                  }
                >
                  Convert to deal
                </button>
                {!canConvertToDeal && (
                  <p className="text-[11px] text-muted">
                    Move it to Qualified, Meeting booked or Handed off first.
                  </p>
                )}
              </>
            ) : (
              <ul className="grid gap-1.5" data-testid="lead-deals">
                {deals.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-baseline gap-2 rounded-[9px] border border-line bg-panel px-2.5 py-2 text-[12px]"
                  >
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    <span className="text-[11px] text-muted">
                      {d.pipelineName} · {d.stageName}
                    </span>
                    <b className="tabular-nums">{d.value.toLocaleString("hu-HU")} Ft</b>
                  </li>
                ))}
                <li>
                  <a
                    href="/deals"
                    className="text-[11.5px] text-accent-ink underline-offset-2 hover:underline"
                  >
                    Open the deals board →
                  </a>
                </li>
              </ul>
            )}
          </section>

          {/**
           * What is open on this lead (playbook-v5 P20/4). Tasks always knew
           * which lead they were about; the lead did not know what was open on
           * it, which meant the follow-up raised from a signal was invisible
           * from the one screen a person actually opens.
           */}
          <EntityTasks kind="lead" entityId={form.id} onCountChange={setOpenTasks} />

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Timeline</p>
            {detail.timeline.length === 0 ? (
              <p className="text-[12px] text-muted">Nothing recorded yet.</p>
            ) : (
              <ul
                className="grid max-h-[280px] gap-2 overflow-y-auto pr-1"
                data-testid="lead-timeline"
              >
                {detail.timeline.map((e) => (
                  <li key={e.id} className="border-l border-line pl-2.5">
                    <span className="block text-[11.5px] text-ink">{e.label}</span>
                    {e.detail && (
                      <span className="block truncate text-[11px] text-muted" title={e.detail}>
                        {e.detail}
                      </span>
                    )}
                    <span className="block text-[10.5px] text-muted tabular-nums">
                      {e.at.slice(0, 16).replace("T", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
