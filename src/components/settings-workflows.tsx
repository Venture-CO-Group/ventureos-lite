"use client";
import { attemptVoid } from "@/lib/client/server-action";
import { attempt } from "@/lib/client/server-action";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteRule,
  saveRule,
  setRuleEnabled,
  type RuleView,
  type WorkflowView,
} from "@/modules/workflow/actions";
import {
  ACTION_DEFS,
  ACTION_TYPES,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  MAX_RULES,
  OPERATOR_LABELS,
  TRIGGERS,
  TRIGGER_DEFS,
  describeRule,
  type Action,
  type ActionType,
  type Condition,
  type ConditionOperator,
  type Trigger,
} from "@/modules/workflow/types";
import { PIPELINE_STAGES, SIDE_STAGES, STAGE_LABELS } from "@/modules/pipeline/transitions";

/**
 * Settings → Automation (playbook-v2 P7/5).
 *
 * WHEN / IF / THEN, read top to bottom, with the plain-English summary of the
 * rule shown above its own editor — because the thing a person needs to check
 * before saving a rule is not the form, it is the sentence the form means.
 *
 * The email action's copy states that it drafts and never sends. That is not
 * reassurance, it is the product's actual behaviour (CLAUDE.md hard rule #2),
 * and it belongs where somebody is choosing the action rather than in a doc.
 */

const FIELD =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BTN =
  "min-h-[34px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

const LEAD_SOURCES = [
  "PROSPECTOR",
  "LINKEDIN",
  "MANUAL",
  "REFERRAL",
  "COLD_EMAIL",
  "SELF_SERVE_AUDIT",
];

interface Draft {
  id?: string;
  name: string;
  trigger: Trigger;
  triggerConfig: Record<string, string | number>;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}

function blankDraft(): Draft {
  return {
    name: "",
    trigger: "lead_stage_changed",
    triggerConfig: {},
    conditions: [],
    actions: [{ type: "create_task", title: "", taskType: "todo", dueInDays: 1 }],
    enabled: true,
  };
}

const STATUS_CHIP: Record<string, string> = {
  matched: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  no_match: "bg-panel text-muted",
  skipped: "bg-[rgba(245,184,65,0.14)] text-[#FFD79A]",
  failed: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]",
};

export function SettingsWorkflows({ view }: { view: WorkflowView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);

  function edit(rule: RuleView) {
    setError(null);
    setDraft({
      id: rule.id,
      name: rule.name,
      trigger: rule.trigger,
      triggerConfig: rule.triggerConfig,
      conditions: rule.conditions,
      actions: rule.actions,
      enabled: rule.enabled,
    });
  }

  function save() {
    if (!draft) return;
    setError(null);
    startTransition(async () => {
      const res = await attempt(saveRule(draft));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDraft(null);
      router.refresh();
    });
  }

  return (
    <section
      data-testid="settings-workflows"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-[18px] lowercase tracking-display">automation</h2>
      <p className="mb-4 max-w-[640px] text-[12.5px] text-muted">
        Rules of the form <b>when</b> something happens, <b>if</b> it looks a certain way,
        <b> then</b> do this. Up to {MAX_RULES} of them. Email actions only ever prepare a
        draft — nothing is sent without a person reading it first.
      </p>

      {error && <p className="mb-3 text-[12.5px] text-[#FFB3C2]">{error}</p>}

      {view.rules.length === 0 ? (
        <p className="mb-4 text-[12.5px] text-muted" data-testid="no-rules">
          No rules yet.
        </p>
      ) : (
        <ul className="mb-4 grid gap-2" data-testid="rule-list">
          {view.rules.map((rule) => (
            <li
              key={rule.id}
              className={`rounded-[11px] border border-line bg-[rgba(0,5,29,0.35)] p-3 ${
                rule.enabled ? "" : "opacity-60"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-[13px]">{rule.name}</b>
                <span className="rounded-full border border-line px-2 py-px text-[10px] text-muted">
                  v{rule.version}
                </span>
                {!rule.enabled && (
                  <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-muted">
                    off
                  </span>
                )}
                {view.isOwner && (
                  <span className="ml-auto flex gap-1.5">
                    <button
                      type="button"
                      className={BTN}
                      disabled={pending}
                      data-testid="rule-toggle"
                      onClick={() =>
                        startTransition(async () => {
                          // A rule that stays on when the operator turned it off
                          // keeps firing on their leads.
                          const failed = await attemptVoid(setRuleEnabled(rule.id, !rule.enabled));
                          if (failed) {
                            setError(failed);
                            return;
                          }
                          router.refresh();
                        })
                      }
                    >
                      {rule.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button type="button" className={BTN} onClick={() => edit(rule)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={BTN}
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const failed = await attemptVoid(deleteRule(rule.id));
                          if (failed) {
                            setError(failed);
                            return;
                          }
                          router.refresh();
                        })
                      }
                    >
                      Delete
                    </button>
                  </span>
                )}
              </div>

              <p className="mt-1 text-[12px] text-muted">{describeRule(rule)}</p>

              <button
                type="button"
                onClick={() => setOpenLog(openLog === rule.id ? null : rule.id)}
                data-testid="rule-log-toggle"
                className="mt-1.5 text-[11.5px] text-accent-ink hover:underline"
              >
                {openLog === rule.id ? "Hide" : "Show"} run log ({rule.recent.length})
              </button>

              {openLog === rule.id && (
                <ul className="mt-1.5 grid gap-1" data-testid="rule-log">
                  {rule.recent.length === 0 && (
                    <li className="text-[11.5px] text-muted">
                      Nothing yet — it has not been triggered.
                    </li>
                  )}
                  {rule.recent.map((run) => (
                    <li key={run.id} className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          STATUS_CHIP[run.status] ?? "bg-panel text-muted"
                        }`}
                      >
                        {run.status.replace("_", " ")}
                      </span>
                      <span className="min-w-0 flex-1 text-muted">{run.detail}</span>
                      <span className="text-muted tabular-nums">
                        v{run.ruleVersion} · {run.at.slice(0, 16).replace("T", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {!view.isOwner ? (
        <p className="text-[12px] text-muted">You need the settings.manage capability to change automation rules.</p>
      ) : draft ? (
        <RuleEditor
          draft={draft}
          view={view}
          pending={pending}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={save}
        />
      ) : (
        <button
          type="button"
          data-testid="rule-new"
          disabled={view.atLimit}
          onClick={() => setDraft(blankDraft())}
          className="min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
        >
          {view.atLimit ? `At the ${MAX_RULES}-rule limit` : "New rule"}
        </button>
      )}
    </section>
  );
}

function RuleEditor({
  draft,
  view,
  pending,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  view: WorkflowView;
  pending: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const def = TRIGGER_DEFS[draft.trigger];
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-3 rounded-[11px] border border-line p-3" data-testid="rule-editor">
      <label className="grid gap-1">
        <span className={LABEL}>Name</span>
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Quote accepted → kick off delivery"
          data-testid="rule-name"
          className={FIELD}
        />
      </label>

      {/* WHEN */}
      <div className="grid gap-1">
        <span className={LABEL}>When</span>
        <select
          value={draft.trigger}
          data-testid="rule-trigger"
          onChange={(e) =>
            set({ trigger: e.target.value as Trigger, triggerConfig: {}, conditions: [] })
          }
          className={FIELD}
        >
          {TRIGGERS.map((t) => (
            <option key={t} value={t}>
              {TRIGGER_DEFS[t].label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted">{def.description}</span>

        {def.config === "stage" && (
          <select
            value={String(draft.triggerConfig.stage ?? "")}
            onChange={(e) => set({ triggerConfig: { stage: e.target.value } })}
            aria-label="Stage"
            className={FIELD}
          >
            <option value="">any stage</option>
            {[...PIPELINE_STAGES, ...SIDE_STAGES].map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        )}
        {def.config === "deal_stage" && (
          <select
            value={String(draft.triggerConfig.stage ?? "")}
            onChange={(e) => set({ triggerConfig: { stage: e.target.value } })}
            aria-label="Deal stage"
            className={FIELD}
          >
            <option value="">any stage</option>
            {view.dealStages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        {def.config === "source" && (
          <select
            value={String(draft.triggerConfig.source ?? "")}
            onChange={(e) => set({ triggerConfig: { source: e.target.value } })}
            aria-label="Source"
            className={FIELD}
          >
            <option value="">any source</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase().replace(/_/g, " ")}
              </option>
            ))}
          </select>
        )}
        {def.config === "days" && (
          <input
            type="number"
            min={0}
            max={365}
            value={Number(draft.triggerConfig.days ?? 1)}
            onChange={(e) => set({ triggerConfig: { days: Number(e.target.value) } })}
            aria-label="Days overdue"
            className={FIELD}
          />
        )}
      </div>

      {/* IF */}
      <div className="grid gap-1.5">
        <span className={LABEL}>If — all of these (optional)</span>
        {draft.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              value={c.field}
              aria-label="Field"
              onChange={(e) =>
                set({
                  conditions: draft.conditions.map((x, j) =>
                    j === i ? { ...x, field: e.target.value } : x,
                  ),
                })
              }
              className={`${FIELD} w-auto min-w-[130px] flex-1`}
            >
              {CONDITION_FIELDS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              value={c.operator}
              aria-label="Operator"
              onChange={(e) =>
                set({
                  conditions: draft.conditions.map((x, j) =>
                    j === i ? { ...x, operator: e.target.value as ConditionOperator } : x,
                  ),
                })
              }
              className={`${FIELD} w-auto min-w-[120px]`}
            >
              {CONDITION_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_LABELS[op]}
                </option>
              ))}
            </select>
            <input
              value={c.value == null ? "" : String(c.value)}
              aria-label="Value"
              onChange={(e) =>
                set({
                  conditions: draft.conditions.map((x, j) =>
                    j === i ? { ...x, value: e.target.value } : x,
                  ),
                })
              }
              className={`${FIELD} w-auto min-w-[110px] flex-1`}
            />
            <button
              type="button"
              aria-label="Remove condition"
              onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}
              className={BTN}
            >
              ✕
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={BTN}
            disabled={draft.conditions.length >= MAX_CONDITIONS}
            data-testid="condition-add"
            onClick={() =>
              set({
                conditions: [...draft.conditions, { field: "stage", operator: "is", value: "" }],
              })
            }
          >
            Add a condition
          </button>
        </div>
      </div>

      {/* THEN */}
      <div className="grid gap-1.5">
        <span className={LABEL}>Then</span>
        {draft.actions.map((a, i) => (
          <div key={i} className="grid gap-1.5 rounded-[9px] border border-line p-2">
            <div className="flex items-center gap-1.5">
              <select
                value={a.type}
                aria-label="Action"
                data-testid="action-type"
                onChange={(e) =>
                  set({
                    actions: draft.actions.map((x, j) =>
                      j === i ? { type: e.target.value as ActionType } : x,
                    ),
                  })
                }
                className={`${FIELD} flex-1`}
              >
                {ACTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACTION_DEFS[t].label}
                  </option>
                ))}
              </select>
              {draft.actions.length > 1 && (
                <button
                  type="button"
                  aria-label="Remove action"
                  onClick={() => set({ actions: draft.actions.filter((_, j) => j !== i) })}
                  className={BTN}
                >
                  ✕
                </button>
              )}
            </div>
            {ACTION_DEFS[a.type].note && (
              <span className="text-[11px] text-muted">{ACTION_DEFS[a.type].note}</span>
            )}

            {a.type === "create_task" && (
              <div className="flex flex-wrap gap-1.5">
                <input
                  value={a.title ?? ""}
                  placeholder="Task title"
                  data-testid="action-task-title"
                  onChange={(e) =>
                    set({
                      actions: draft.actions.map((x, j) =>
                        j === i ? { ...x, title: e.target.value } : x,
                      ),
                    })
                  }
                  className={`${FIELD} flex-1`}
                />
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={a.dueInDays ?? 1}
                  aria-label="Due in days"
                  onChange={(e) =>
                    set({
                      actions: draft.actions.map((x, j) =>
                        j === i ? { ...x, dueInDays: Number(e.target.value) } : x,
                      ),
                    })
                  }
                  className={`${FIELD} w-[90px]`}
                />
              </div>
            )}

            {a.type === "draft_email" && (
              <div className="grid gap-1.5">
                <select
                  value={a.templateId ?? ""}
                  aria-label="Email template"
                  onChange={(e) =>
                    set({
                      actions: draft.actions.map((x, j) =>
                        j === i ? { ...x, templateId: e.target.value || undefined } : x,
                      ),
                    })
                  }
                  className={FIELD}
                >
                  <option value="">no template — write the body below</option>
                  {view.emailTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <input
                  value={a.subject ?? ""}
                  placeholder="Subject"
                  onChange={(e) =>
                    set({
                      actions: draft.actions.map((x, j) =>
                        j === i ? { ...x, subject: e.target.value } : x,
                      ),
                    })
                  }
                  className={FIELD}
                />
                {!a.templateId && (
                  <textarea
                    value={a.body ?? ""}
                    rows={3}
                    placeholder="Draft body"
                    onChange={(e) =>
                      set({
                        actions: draft.actions.map((x, j) =>
                          j === i ? { ...x, body: e.target.value } : x,
                        ),
                      })
                    }
                    className={FIELD}
                  />
                )}
              </div>
            )}

            {(a.type === "add_signal" || a.type === "remove_signal") && (
              <input
                value={a.signal ?? ""}
                placeholder="Signal tag"
                onChange={(e) =>
                  set({
                    actions: draft.actions.map((x, j) =>
                      j === i ? { ...x, signal: e.target.value } : x,
                    ),
                  })
                }
                className={FIELD}
              />
            )}

            {a.type === "notify_user" && (
              <div className="grid gap-1.5">
                <select
                  value={a.userId ?? ""}
                  aria-label="Notify"
                  onChange={(e) =>
                    set({
                      actions: draft.actions.map((x, j) =>
                        j === i ? { ...x, userId: e.target.value } : x,
                      ),
                    })
                  }
                  className={FIELD}
                >
                  <option value="">choose someone…</option>
                  {view.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <input
                  value={a.message ?? ""}
                  placeholder="What the notification says"
                  onChange={(e) =>
                    set({
                      actions: draft.actions.map((x, j) =>
                        j === i ? { ...x, message: e.target.value } : x,
                      ),
                    })
                  }
                  className={FIELD}
                />
              </div>
            )}
          </div>
        ))}
        <div>
          <button
            type="button"
            className={BTN}
            disabled={draft.actions.length >= MAX_ACTIONS}
            data-testid="action-add"
            onClick={() =>
              set({ actions: [...draft.actions, { type: "add_signal", signal: "" }] })
            }
          >
            Add an action
          </button>
        </div>
      </div>

      <p className="rounded-[9px] border border-line bg-[rgba(0,5,29,0.35)] px-3 py-2 text-[12px] text-muted">
        {describeRule(draft)}
      </p>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={pending || !draft.name.trim()}
          data-testid="rule-save"
          className="min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
        >
          {pending ? "Saving…" : "Save rule"}
        </button>
      </div>
    </div>
  );
}
