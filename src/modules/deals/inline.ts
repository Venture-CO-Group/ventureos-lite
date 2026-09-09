/**
 * Editing one field of one deal (playbook-v5 P16/1).
 *
 * WHAT IS EDITABLE IN PLACE, and what deliberately is not:
 *   - title, value, expected close date, probability and the owner: yes.
 *   - `stageId`: no. Moving a deal is `moveStageIn` — it stamps
 *     `stageEnteredAt`, records an undo, runs the workflow triggers and, on a
 *     closing stage, REQUIRES A REASON. A cell that wrote the column would
 *     skip all four and produce a deal that closed for no stated reason.
 *   - `status` / `closedAt` / `lostReason`: no, for the same reason. Closing is
 *     a decision with a mandatory explanation, not a dropdown.
 *   - `currency`: no. It is per workspace, and a per-deal currency would make
 *     the forecast a sum of unlike numbers.
 *
 * MONEY IS AN INTEGER OF FORINTS (CLAUDE.md). A cell that accepted "1.5" and
 * stored 1.5 would round somewhere later and be wrong by the time anybody
 * noticed, so a fractional amount is refused rather than coerced.
 */

import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";

export const DEAL_INLINE_FIELDS = [
  "title",
  "value",
  "expectedCloseAt",
  "probability",
  "ownerId",
] as const;
export type DealInlineField = (typeof DEAL_INLINE_FIELDS)[number];

export function isDealInlineField(field: string): field is DealInlineField {
  return (DEAL_INLINE_FIELDS as readonly string[]).includes(field);
}

export const DEAL_UNEDITABLE_REASON: Record<string, string> = {
  stageId: "Drag the deal to move it — closing a stage needs a reason.",
  status: "Close the deal from the board, where it can ask why.",
  closedAt: "Close the deal from the board, where it can ask why.",
  lostReason: "Close the deal from the board, where it can ask why.",
  currency: "The currency is set for the whole workspace.",
};

export type DealInlineResult = { ok: true; value: unknown } | { ok: false; error: string };

const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);

export async function applyDealInlineEdit(
  workspaceId: string,
  actorUserId: string | null,
  input: { dealId: string; field: string; value: unknown },
): Promise<DealInlineResult> {
  const parsedValue = valueSchema.safeParse(input.value ?? null);
  if (!parsedValue.success) return { ok: false, error: "That value is not allowed." };
  const value = parsedValue.data;

  if (!isDealInlineField(input.field)) {
    const reason = DEAL_UNEDITABLE_REASON[input.field];
    return { ok: false, error: reason ?? "That field cannot be edited in place." };
  }

  const db = getWorkspaceClient(workspaceId);
  const deal = await db.deal.findUnique({
    where: { id: input.dealId },
    select: { id: true, status: true },
  });
  if (!deal) return { ok: false, error: "Deal not found." };

  /**
   * A closed deal is a record of what happened. Editing its amount after the
   * fact rewrites history that the revenue figures are already built on, so
   * the refusal says where to go instead.
   */
  if (deal.status !== "OPEN") {
    return { ok: false, error: "This deal is closed — reopen it before changing its numbers." };
  }

  if (input.field === "title") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { ok: false, error: "A deal needs a title." };
    if (text.length > 200) return { ok: false, error: "That title is too long." };
    await db.deal.update({ where: { id: deal.id }, data: { title: text } });
    return { ok: true, value: text };
  }

  if (input.field === "value") {
    const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/\s/g, ""));
    if (!Number.isFinite(n)) return { ok: false, error: "That is not an amount." };
    if (!Number.isInteger(n)) return { ok: false, error: "Amounts are whole forints." };
    if (n < 0) return { ok: false, error: "An amount cannot be negative." };
    // A hundred billion forints is not a deal, it is a typo with three extra
    // zeroes — and it would dominate every forecast until somebody found it.
    if (n > 100_000_000_000) return { ok: false, error: "That amount looks like a typo." };
    await db.deal.update({ where: { id: deal.id }, data: { value: n } });
    return { ok: true, value: n };
  }

  if (input.field === "probability") {
    if (value === null || value === "") {
      await db.deal.update({ where: { id: deal.id }, data: { probability: null } });
      return { ok: true, value: null };
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return { ok: false, error: "A probability is a whole number from 0 to 100." };
    }
    await db.deal.update({ where: { id: deal.id }, data: { probability: n } });
    return { ok: true, value: n };
  }

  if (input.field === "expectedCloseAt") {
    if (value === null || value === "") {
      await db.deal.update({ where: { id: deal.id }, data: { expectedCloseAt: null } });
      return { ok: true, value: null };
    }
    const m = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
    const d = m ? new Date(`${String(value).trim()}T12:00:00.000Z`) : new Date(NaN);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "That is not a date." };
    await db.deal.update({ where: { id: deal.id }, data: { expectedCloseAt: d } });
    return { ok: true, value: d.toISOString().slice(0, 10) };
  }

  const ownerId = typeof value === "string" && value ? value : null;
  if (ownerId) {
    const member = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: ownerId, workspaceId } },
      select: { state: true },
    });
    if (!member) return { ok: false, error: "That person is not in this workspace." };
    if (member.state !== "ACTIVE") {
      return { ok: false, error: "That person's access is suspended — give it to somebody else." };
    }
  }
  await db.deal.update({ where: { id: deal.id }, data: { ownerId } });
  void actorUserId;
  return { ok: true, value: ownerId };
}
