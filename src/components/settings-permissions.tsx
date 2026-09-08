import { Fragment } from "react";
import {
  MATRIX_ROLES,
  buildMatrix,
  roleSummary,
} from "@/modules/members/permission-matrix";

/**
 * The permission matrix (§6).
 *
 * ── WHY THIS REPLACES A CHECKLIST ───────────────────────────────────────────
 *
 * The grants panel was fourteen checkboxes with their identifiers beside them.
 * It could tell you a box was ticked and nothing else — not what the box
 * governs, not whether the role already carried it, not why the tick was
 * there. The questions people actually arrive with ("what does an Admin get
 * that a BDR does not") had no answer on the screen meant to answer them.
 *
 * A server component with no state: every cell is `grantAllowed` and
 * `grantIsImplicit` asked at render time. Nothing here is written down, which
 * is the whole requirement — a matrix maintained by hand disagrees with the
 * server the first time somebody edits the model, and nobody notices because a
 * stale matrix still renders perfectly.
 */
export function SettingsPermissions() {
  const groups = buildMatrix();

  return (
    <section
      data-testid="settings-permissions"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-2xl font-bold lowercase tracking-display">
        what each role can do
      </h2>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        Read from the permission model at render time, so it cannot drift from
        what the server enforces. <b>●</b> the role carries it · <b>○</b> can be
        handed over per person · <b>·</b> not available to that role.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
              <th className="px-2 py-1.5 font-semibold">Capability</th>
              {MATRIX_ROLES.map((r) => (
                <th key={r} className="px-2 py-1.5 text-center font-semibold">
                  {r}
                  <span className="block text-[9.5px] normal-case tracking-normal">
                    {roleSummary(r)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              /* A keyed Fragment: a bare <> inside a map has no key, and React
                 logs a warning per group — which `every-page.spec.ts`
                 correctly treats as a failure. */
              <Fragment key={group.module}>
                <tr>
                  <td
                    colSpan={MATRIX_ROLES.length + 1}
                    className="border-b border-line px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted"
                  >
                    {group.module}
                  </td>
                </tr>
                {group.rows.map((row) => (
                  <tr
                    key={row.grant}
                    data-testid={`matrix-row-${row.grant}`}
                    className="border-b border-line last:border-0"
                  >
                    <td className="px-2 py-1.5">
                      <code className="text-[11.5px] text-ink">{row.grant}</code>
                      {row.documentGrant && (
                        <span
                          title="Stays behind an explicit grant whatever the role: these decide what the company is legally bound by."
                          className="ml-1.5 rounded-[5px] bg-panel-2 px-1.5 py-px text-[10px] text-muted"
                        >
                          legal
                        </span>
                      )}
                    </td>
                    {row.cells.map((c) => (
                      <td
                        key={c.role}
                        data-testid={`matrix-${row.grant}-${c.role}`}
                        className="px-2 py-1.5 text-center"
                        title={
                          c.inherent
                            ? `${c.role} carries this without any grant`
                            : c.grantable
                              ? `Can be granted to a ${c.role} per person`
                              : `Not available to a ${c.role}`
                        }
                      >
                        <span
                          className={
                            c.inherent
                              ? "text-[#8CEFC0]"
                              : c.grantable
                                ? "text-[#FFD79A]"
                                : "text-muted"
                          }
                        >
                          {c.inherent ? "●" : c.grantable ? "○" : "·"}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        A <b>client</b> carries nothing and can be granted nothing — the
        resolver refuses every capability before it reads the grant list, which
        is why that column is empty rather than missing.
        <br />
        Owner and Admin differ nowhere in this table. The difference between
        them is <code>requireOwner</code> — user management, provisioning,
        integration credentials, ownership — which no capability reaches, so
        claiming a difference here would be describing something that does not
        exist.
      </p>
    </section>
  );
}
