"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addSubscription,
  listSubscribableCompanies,
  setSubscriptionStatus,
  type CompanyOption,
} from "@/modules/revenue/actions";
import { CHURN_REASONS, SUBSCRIPTION_SOURCES } from "@/modules/revenue/subscriptions";
import { Modal } from "./modal";

/**
 * Adding a subscription, and ending one (playbook-v3 P11/1a, 1e).
 *
 * The churn dialog is the reason sub-item (e) exists: marking a subscription
 * churned PROMPTS for a reason, and the confirm button stays disabled until one
 * is chosen. The reason is what makes the breakdown on the Revenue tab worth
 * rendering — a churn list of "other, other, other" tells nobody anything.
 */

const input =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent";
const label = "mb-2.5 block text-[12.5px]";

function humanReason(reason: string): string {
  return reason.replace(/_/g, " ");
}

export function AddSubscriptionDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyOption[] | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [planName, setPlanName] = useState("");
  const [monthlyNet, setMonthlyNet] = useState("");
  const [source, setSource] = useState<string>("retainer");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The list is capped server-side, so it has to be searchable: a workspace
  // with hundreds of companies otherwise cannot reach the ones after the cap.
  const [companyQuery, setCompanyQuery] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      listSubscribableCompanies(companyQuery).then((list) => {
        if (!active) return;
        setCompanies(list);
        // Keep a chosen company selected while the search narrows around it.
        setCompanyId((current) =>
          current && list.some((c) => c.id === current) ? current : (list[0]?.id ?? ""),
        );
      });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [companyQuery]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await addSubscription({
        companyId,
        planName,
        monthlyNet,
        startDate,
        source,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">add subscription</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Starting a subscription promotes the company to client status, dated from
        the start date.
      </p>
      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

      <label className={label}>
        Client
        <input
          value={companyQuery}
          onChange={(e) => setCompanyQuery(e.target.value)}
          placeholder="Search companies…"
          data-testid="sub-company-search"
          className={`${input} mt-1`}
        />
        <select
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          data-testid="sub-company"
          className={`${input} mt-1`}
        >
          {companies === null && <option>Loading…</option>}
          {companies?.length === 0 && <option value="">no company matches that</option>}
          {companies?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.isClient ? "★ " : ""}
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className={label}>
        Plan
        <input
          value={planName}
          onChange={(e) => setPlanName(e.target.value)}
          placeholder="Hosting + retainer"
          data-testid="sub-plan"
          className={`${input} mt-1`}
        />
      </label>

      <div className="mb-2.5 grid grid-cols-2 gap-2">
        <label className="block text-[12.5px]">
          Monthly net (Ft)
          <input
            type="number"
            min={1}
            value={monthlyNet}
            onChange={(e) => setMonthlyNet(e.target.value)}
            data-testid="sub-amount"
            className={`${input} mt-1 tabular-nums`}
          />
        </label>
        <label className="block text-[12.5px]">
          Starts
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            data-testid="sub-start"
            className={`${input} mt-1`}
          />
        </label>
      </div>

      <label className={label}>
        Source
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          data-testid="sub-source"
          className={`${input} mt-1`}
        >
          {SUBSCRIPTION_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={busy || !companyId || !planName.trim() || !monthlyNet}
          data-testid="sub-save"
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Saving…" : "Add subscription"}
        </button>
      </div>
    </Modal>
  );
}

export function ChurnDialog({
  subscriptionId,
  companyName,
  monthlyNet,
  onClose,
}: {
  subscriptionId: string;
  companyName: string;
  monthlyNet: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function churn() {
    setBusy(true);
    setError(null);
    try {
      const res = await setSubscriptionStatus({
        subscriptionId,
        status: "CHURNED",
        reason,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">end subscription</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        {companyName} — {monthlyNet.toLocaleString("hu-HU")} Ft/month leaves the book
        today. Commission stops with it: only payments actually received count, so
        nothing further accrues once the invoices stop.
      </p>
      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

      <div className="mb-3 grid gap-1.5">
        <span className="text-[12.5px]">Why are they leaving?</span>
        <div className="flex flex-wrap gap-1.5">
          {CHURN_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              aria-pressed={reason === r}
              data-testid={`churn-reason-${r}`}
              className={`rounded-full border px-2.5 py-1 text-[11.5px] ${
                reason === r
                  ? "border-accent bg-accent-soft text-[#E4D3FF]"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {humanReason(r)}
            </button>
          ))}
        </div>
        <span className="text-[11.5px] text-muted">
          From a fixed list, so the breakdown counts rather than collecting synonyms.
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          onClick={churn}
          disabled={busy || !reason}
          data-testid="churn-confirm"
          title={reason ? undefined : "Pick a reason first"}
          className="rounded-[10px] border border-[rgba(255,92,122,0.5)] bg-[rgba(255,92,122,0.12)] px-4 py-2 text-[13px] font-semibold text-[#FFB3C2] hover:bg-[rgba(255,92,122,0.2)] disabled:opacity-50"
        >
          {busy ? "Ending…" : "End subscription"}
        </button>
      </div>
    </Modal>
  );
}
