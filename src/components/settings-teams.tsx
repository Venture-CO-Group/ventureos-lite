"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  deleteTeam,
  getTeamImpact,
  saveTeam,
  setTeamArchived,
  setTeamMember,
} from "@/modules/teams/actions";
import type { TeamView } from "@/modules/teams/store";

/**
 * Teams (§5).
 *
 * ── WHAT IS NOT ON THIS PANEL ───────────────────────────────────────────────
 *
 * Permissions. Deliberately, and it is the most important thing about the
 * feature: a team grants nothing. Authority stays role + grant, and a team
 * carrying capabilities would be a second authorization system whose answers
 * disagree with the first the moment somebody is on two teams.
 *
 * What is here: who is on it, who leads it, and how much each of them is
 * carrying — because "who is swamped" and "who do I escalate to" are the two
 * questions a team page gets opened for.
 */
const BTN =
  "min-h-[30px] rounded-[8px] border border-line px-2 py-0.5 text-[11px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";

export function SettingsTeams({
  teams,
  members,
}: {
  teams: TeamView[];
  /** Active staff who could be on a team. */
  members: { id: string; name: string; email: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#7427C6");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await fn();
        setMsg(res.ok ? { kind: "ok", text: ok } : { kind: "err", text: res.error ?? "Failed." });
        if (res.ok) router.refresh();
      } catch (e) {
        setMsg({ kind: "err", text: serverActionError(e) });
      }
    });
  }

  return (
    <section
      data-testid="settings-teams"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">teams</h2>
        <button onClick={() => setCreating((v) => !v)} data-testid="team-new" className={BTN}>
          {creating ? "Cancel" : "+ New team"}
        </button>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        A grouping for assignment, filtering, analytics and escalation. Teams
        carry <b>no permissions</b> — what somebody may do stays their role and
        their capabilities, so there is only ever one answer to “why can Anna do
        that”.
      </p>

      {msg && (
        <p
          role={msg.kind === "err" ? "alert" : undefined}
          data-testid="teams-message"
          className={`mb-3 rounded-[8px] border px-3 py-2 text-[12px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {creating && (
        <div className="mb-3 grid gap-2 rounded-[10px] border border-accent bg-panel-2 p-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team name"
            data-testid="team-name"
            className={INPUT}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this team is for"
            data-testid="team-description"
            className={INPUT}
          />
          <label className="flex items-center gap-2 text-[12px] text-muted">
            Colour
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              data-testid="team-color"
              className="h-8 w-12 rounded border border-line bg-transparent"
            />
          </label>
          <button
            onClick={() =>
              run(() => saveTeam({ name, description, color }), `Created ${name}.`)
            }
            disabled={pending || !name.trim()}
            data-testid="team-create"
            className={`${BTN} w-fit`}
          >
            Create
          </button>
        </div>
      )}

      {teams.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          No teams yet. On a team of two or three they add nothing — make one
          when “the Budapest desk” starts being a thing people say.
        </p>
      ) : (
        <ul className="grid gap-2">
          {teams.map((t) => {
            const load = t.members.reduce((n, m) => n + m.openTasks + m.openDeals, 0);
            return (
              <li
                key={t.id}
                data-testid={`team-${t.id}`}
                className="rounded-[10px] border border-line bg-panel-2 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 flex-none rounded-full"
                    style={{ background: t.color ?? "#7427C6" }}
                  />
                  <b className="text-[13px]">{t.name}</b>
                  {t.archivedAt && (
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                      archived
                    </span>
                  )}
                  <span className="text-[11.5px] tabular-nums text-muted">
                    {t.members.length} {t.members.length === 1 ? "person" : "people"} · {load} open
                  </span>
                  <button
                    onClick={() => setOpen(open === t.id ? null : t.id)}
                    data-testid={`team-open-${t.id}`}
                    className={`${BTN} ml-auto`}
                  >
                    {open === t.id ? "Close" : "Manage"}
                  </button>
                </div>
                {t.description && (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{t.description}</p>
                )}

                {open === t.id && (
                  <div className="mt-2.5 grid gap-2 border-t border-line pt-2.5">
                    {/* ---- who is on it, and how loaded they are ---- */}
                    {t.members.length > 0 && (
                      <ul className="grid gap-1" data-testid={`team-members-${t.id}`}>
                        {t.members.map((m) => (
                          <li
                            key={m.userId}
                            className="flex flex-wrap items-baseline gap-2 text-[11.5px]"
                          >
                            <span className="text-ink">{m.name}</span>
                            {m.isLead && (
                              <span className="rounded-[5px] bg-accent-soft px-1.5 py-px text-[10px] text-[#E4D3FF]">
                                lead
                              </span>
                            )}
                            <span className="tabular-nums text-muted">
                              {m.openTasks} tasks · {m.openDeals} deals
                            </span>
                            <span className="ml-auto flex gap-1">
                              <button
                                onClick={() =>
                                  run(
                                    () =>
                                      setTeamMember({
                                        teamId: t.id,
                                        userId: m.userId,
                                        on: true,
                                        isLead: !m.isLead,
                                      }),
                                    m.isLead ? "No longer the lead." : `${m.name} leads the team.`,
                                  )
                                }
                                disabled={pending}
                                data-testid={`team-lead-${t.id}-${m.userId}`}
                                className={BTN}
                              >
                                {m.isLead ? "Not lead" : "Make lead"}
                              </button>
                              <button
                                onClick={() =>
                                  run(
                                    () =>
                                      setTeamMember({ teamId: t.id, userId: m.userId, on: false }),
                                    `${m.name} taken off ${t.name}.`,
                                  )
                                }
                                disabled={pending}
                                data-testid={`team-remove-${t.id}-${m.userId}`}
                                className={BTN}
                              >
                                Remove
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* ---- add somebody ---- */}
                    <select
                      value=""
                      onChange={(e) => {
                        const userId = e.target.value;
                        if (!userId) return;
                        run(
                          () => setTeamMember({ teamId: t.id, userId, on: true }),
                          "Added to the team.",
                        );
                      }}
                      data-testid={`team-add-${t.id}`}
                      className={INPUT}
                    >
                      <option value="">Add somebody…</option>
                      {members
                        .filter((m) => !t.members.some((tm) => tm.userId === m.id))
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>

                    <div className="flex flex-wrap gap-1.5">
                      <button
                        onClick={() =>
                          run(
                            () => setTeamArchived({ teamId: t.id, archived: !t.archivedAt }),
                            t.archivedAt ? "Back in use." : "Archived.",
                          )
                        }
                        disabled={pending}
                        data-testid={`team-archive-${t.id}`}
                        className={BTN}
                      >
                        {t.archivedAt ? "Bring it back" : "Archive"}
                      </button>
                      <button
                        onClick={() => {
                          startTransition(async () => {
                            const impact = await getTeamImpact(t.id);
                            if ("error" in impact) {
                              setMsg({ kind: "err", text: impact.error });
                              return;
                            }
                            if (!impact.canDelete) {
                              // The same impact-report pattern as removing a
                              // member: say what is in the way rather than
                              // refusing blankly.
                              setMsg({ kind: "err", text: impact.reason ?? "Still in use." });
                              return;
                            }
                            const res = await deleteTeam(t.id);
                            setMsg(
                              res.ok
                                ? { kind: "ok", text: `${t.name} deleted.` }
                                : { kind: "err", text: res.error },
                            );
                            if (res.ok) router.refresh();
                          });
                        }}
                        disabled={pending}
                        data-testid={`team-delete-${t.id}`}
                        className={`${BTN} hover:border-[#FFB3C2]`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
