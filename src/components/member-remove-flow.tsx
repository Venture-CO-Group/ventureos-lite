"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  getRemovalImpact,
  removeMemberFromWorkspace,
} from "@/modules/members/admin-actions";
import { OWNED_CATEGORIES } from "@/modules/members/reassignment";
import type { ImpactReport } from "@/modules/members/removal";
import type { ManagedUser } from "@/modules/users/actions";

/**
 * Removing somebody, as a guided flow (§4).
 *
 * ── WHY FOUR STEPS AND NOT A CONFIRM DIALOG ─────────────────────────────────
 *
 * This is the dangerous action in the product. A dialog saying "are you sure"
 * asks a question nobody can answer, because the thing you need to know is
 * what this person is holding — and that is exactly what a dialog does not
 * tell you.
 *
 * So: see the impact, choose where each category goes, decide about their
 * mailbox, then type their name. The typed name is checked on the SERVER as
 * well, because a check that only exists in the browser is decoration.
 */
const BTN =
  "min-h-[34px] rounded-[9px] border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";

type Target = { kind: "user"; userId: string } | { kind: "team"; teamId: string } | { kind: "unassign" };

export function MemberRemoveFlow({
  user,
  candidates,
  teams,
  onClose,
}: {
  user: ManagedUser;
  /** Active staff who could take the work. */
  candidates: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [plan, setPlan] = useState<Record<string, Target>>({});
  const [applyToAll, setApplyToAll] = useState("");
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [disconnectMail, setDisconnectMail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await getRemovalImpact(user.userId);
      if ("error" in res) setError(res.error);
      else setImpact(res);
    })();
  }, [user.userId]);

  /** Categories they actually hold — the rest are not decisions to make. */
  const held = OWNED_CATEGORIES.filter((c) => (impact?.counts[c.key] ?? 0) > 0);

  function setAll(value: string) {
    setApplyToAll(value);
    if (!value) return;
    const next: Record<string, Target> = {};
    for (const c of held) {
      if (value === "unassign") {
        // Only where it is legal; the others keep whatever was chosen.
        if (c.mayUnassign) next[c.key] = { kind: "unassign" };
        else if (plan[c.key]) next[c.key] = plan[c.key]!;
      } else if (value.startsWith("team:")) {
        next[c.key] = { kind: "team", teamId: value.slice(5) };
      } else {
        next[c.key] = { kind: "user", userId: value };
      }
    }
    setPlan(next);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const res = await removeMemberFromWorkspace({
        userId: user.userId,
        confirmName,
        reason,
        plan,
        disconnectMail,
      });
      if (!res.ok) {
        setError(res.error);
        setProblems(res.problems ?? []);
        return;
      }
      router.refresh();
      onClose();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,5,29,0.75)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Remove ${user.name}`}
    >
      <div
        data-testid="remove-flow"
        className="max-h-full w-full max-w-[560px] overflow-y-auto rounded-card border border-line bg-canvas p-5"
      >
        <div className="mb-3 flex items-start">
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-lg font-bold lowercase">
              remove {user.name.toLowerCase()}
            </h3>
            <p className="text-[11.5px] text-muted">
              Step {step} of 4 · their name stays on everything they created
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        {error && (
          <p role="alert" data-testid="remove-error" className="mb-3 text-[12.5px] text-[#FFB3C2]">
            {error}
          </p>
        )}
        {problems.length > 0 && (
          <ul data-testid="remove-problems" className="mb-3 grid gap-1">
            {problems.map((p) => (
              <li key={p} className="text-[12px] text-[#FFB3C2]">
                {p}
              </li>
            ))}
          </ul>
        )}

        {/* ---- 1: the impact report ---- */}
        {step === 1 && (
          <div className="grid gap-2.5">
            {!impact && <p className="text-[12.5px] text-muted">Counting…</p>}
            {impact && (
              <>
                <p className="text-[12.5px] leading-relaxed text-muted">
                  {impact.total === 0
                    ? "They are not holding anything. Nothing needs reassigning."
                    : `They are holding ${impact.total} thing(s). Every one needs somewhere to go.`}
                </p>
                <ul data-testid="impact-report" className="grid gap-1">
                  {OWNED_CATEGORIES.map((c) => (
                    <li
                      key={c.key}
                      className="flex flex-wrap items-baseline gap-2 rounded-[9px] border border-line bg-panel-2 px-2.5 py-1.5"
                    >
                      <b className="text-[12px]">{c.label}</b>
                      <b
                        data-testid={`impact-${c.key}`}
                        className="tabular-nums text-[12px] text-ink"
                      >
                        {impact.counts[c.key] ?? 0}
                      </b>
                      <span className="w-full text-[11px] leading-relaxed text-muted">
                        {c.hint}
                      </span>
                    </li>
                  ))}
                </ul>
                {impact.isLastOwner && (
                  <p className="text-[12.5px] text-[#FFB3C2]" data-testid="impact-last-owner">
                    They are the last Owner who can sign in. Transfer ownership to
                    somebody else before removing them.
                  </p>
                )}
              </>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <button onClick={onClose} className={BTN}>
                Cancel
              </button>
              <button
                onClick={() => setStep(2)}
                disabled={!impact || impact.isLastOwner}
                data-testid="remove-next-1"
                className={BTN}
              >
                Next: where does it go
              </button>
            </div>
          </div>
        )}

        {/* ---- 2: the reassignment plan ---- */}
        {step === 2 && (
          <div className="grid gap-2.5">
            {held.length === 0 ? (
              <p className="text-[12.5px] text-muted">
                Nothing to reassign — straight on.
              </p>
            ) : (
              <>
                <label className="grid gap-1">
                  <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
                    Hand everything to
                  </span>
                  <select
                    value={applyToAll}
                    onChange={(e) => setAll(e.target.value)}
                    data-testid="remove-all-target"
                    className={INPUT}
                  >
                    <option value="">Choose per category below…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    {teams.map((t) => (
                      <option key={t.id} value={`team:${t.id}`}>
                        Team: {t.name}
                      </option>
                    ))}
                    <option value="unassign">Leave unassigned where allowed</option>
                  </select>
                </label>
                <ul className="grid gap-1.5">
                  {held.map((c) => (
                    <li
                      key={c.key}
                      className="grid gap-1 rounded-[9px] border border-line bg-panel-2 px-2.5 py-2"
                    >
                      <span className="text-[11.5px]">
                        <b>{c.label}</b>{" "}
                        <span className="tabular-nums text-muted">
                          ({impact?.counts[c.key] ?? 0})
                        </span>
                      </span>
                      <select
                        value={
                          plan[c.key]?.kind === "user"
                            ? (plan[c.key] as { userId: string }).userId
                            : plan[c.key]?.kind === "team"
                              ? `team:${(plan[c.key] as { teamId: string }).teamId}`
                              : plan[c.key]?.kind === "unassign"
                                ? "unassign"
                                : ""
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setPlan((cur) => ({
                            ...cur,
                            [c.key]:
                              v === "unassign"
                                ? { kind: "unassign" }
                                : v.startsWith("team:")
                                  ? { kind: "team", teamId: v.slice(5) }
                                  : { kind: "user", userId: v },
                          }));
                        }}
                        data-testid={`remove-target-${c.key}`}
                        className={INPUT}
                      >
                        <option value="">Choose…</option>
                        {candidates.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                        {teams.map((t) => (
                          <option key={t.id} value={`team:${t.id}`}>
                            Team: {t.name}
                          </option>
                        ))}
                        {/* Offered only where it is legal — an unowned open
                            deal is money nobody is chasing. */}
                        {c.mayUnassign && <option value="unassign">Leave unassigned</option>}
                      </select>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <button onClick={() => setStep(1)} className={BTN}>
                Back
              </button>
              <button onClick={() => setStep(3)} data-testid="remove-next-2" className={BTN}>
                Next: their mailbox
              </button>
            </div>
          </div>
        )}

        {/* ---- 3: mail and calendar ---- */}
        {step === 3 && (
          <div className="grid gap-2.5">
            <label className="flex items-start gap-2 rounded-[9px] border border-line bg-panel-2 px-3 py-2.5">
              <input
                type="checkbox"
                checked={disconnectMail}
                onChange={(e) => setDisconnectMail(e.target.checked)}
                data-testid="remove-disconnect-mail"
                style={{ accentColor: "#7427C6" }}
                className="mt-[3px]"
              />
              <span>
                <b className="block text-[12.5px]">
                  Disconnect their mailbox and calendar
                  {impact && impact.mailAccounts > 0 && ` (${impact.mailAccounts} connected)`}
                </b>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                  Nothing new syncs after this. The threads already filed against
                  a lead <b>stay</b> — they are correspondence with a client, and
                  deleting them because the person who synced them left would
                  destroy the history the Inbox exists to keep.
                </span>
              </span>
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <button onClick={() => setStep(2)} className={BTN}>
                Back
              </button>
              <button onClick={() => setStep(4)} data-testid="remove-next-3" className={BTN}>
                Next: confirm
              </button>
            </div>
          </div>
        )}

        {/* ---- 4: reason and the typed name ---- */}
        {step === 4 && (
          <div className="grid gap-2.5">
            <label className="grid gap-1">
              <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
                Why (goes on the record)
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Left the company on the 30th"
                data-testid="remove-reason"
                className={INPUT}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
                Type “{user.name}” to confirm
              </span>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                data-testid="remove-confirm-name"
                className={INPUT}
              />
            </label>
            <p className="text-[11.5px] leading-relaxed text-muted">
              Their access ends immediately and every device is signed out. Their
              name stays on everything they created, and they stay in the audit
              history — removal ends access, it does not rewrite what they did.
            </p>
            <div className="mt-1 flex justify-end gap-2">
              <button onClick={() => setStep(3)} className={BTN}>
                Back
              </button>
              <button
                onClick={() => void submit()}
                disabled={busy || !reason.trim() || !confirmName.trim()}
                data-testid="remove-submit"
                className={`${BTN} border-[#FFB3C2] text-[#FFB3C2]`}
              >
                {busy ? "Removing…" : "Remove them"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
