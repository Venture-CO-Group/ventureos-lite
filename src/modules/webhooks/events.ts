/**
 * The outbound event catalogue (P5/5.2).
 *
 * ── WHY THIS IS A CLOSED LIST ───────────────────────────────────────────────
 *
 * The software could already RECEIVE a webhook (`api/webhooks/mailgun`). It
 * could not tell anything else that a lead moved stage or an offer was
 * accepted — which is the difference between a tool and an island.
 *
 * A fixed catalogue rather than "anything the code feels like emitting": an
 * endpoint subscribes to names, and a name that changes shape between releases
 * breaks somebody else's system silently. These strings are part of the
 * contract now.
 *
 * A plain module, not `"use server"` — a file marked so may only export async
 * functions, and a const array exported from one kills the build. The third
 * time that trap has been worth a comment.
 */

export interface WebhookEventDef {
  id: string;
  label: string;
  /** What the payload carries, for the settings screen. */
  hint: string;
}

export const WEBHOOK_EVENTS: readonly WebhookEventDef[] = [
  {
    id: "lead.created",
    label: "Új lead",
    hint: "A lead azonosítója, a cég neve, a forrás és az ICP pontszám.",
  },
  {
    id: "lead.stage_changed",
    label: "Lead stádiumot váltott",
    hint: "Honnan hová, ki mozgatta, és az indoklás ha volt.",
  },
  {
    id: "deal.stage_changed",
    label: "Deal stádiumot váltott",
    hint: "A pipeline, az új stádium neve, és hogy nyert/vesztett/nyitott.",
  },
  {
    id: "deal.won",
    label: "Deal megnyerve",
    hint: "A deal értéke forintban, a cég, és a lead amiből lett.",
  },
  {
    id: "document.finalized",
    label: "Dokumentum véglegesítve",
    hint: "A dokumentum típusa (ajánlat/szerződés/teljesítési igazolás) és a végösszeg.",
  },
  {
    id: "document.accepted",
    label: "Ajánlat elfogadva",
    hint: "Melyik ajánlatot fogadta el az ügyfél, és mikor.",
  },
  {
    id: "invoice.issued",
    label: "Számla kiállítva",
    hint: "A számlaszám és a végösszeg, a Számlázz.hu visszaigazolása után.",
  },
  {
    id: "meeting.booked",
    label: "Megbeszélés lefoglalva",
    hint: "A kezdés időpontja, a résztvevő és a foglalólap.",
  },
  {
    id: "audit.completed",
    label: "Weboldal-audit elkészült",
    hint: "A vizsgált domain, az összpontszám és a verdikt.",
  },
] as const;

export const WEBHOOK_EVENT_IDS: readonly string[] = WEBHOOK_EVENTS.map((e) => e.id);

export function isWebhookEvent(id: string): boolean {
  return WEBHOOK_EVENT_IDS.includes(id);
}

/**
 * Read a subscription list off the JSON column.
 *
 * Anything unrecognised is dropped rather than kept. An event id that no longer
 * exists cannot fire, so keeping it would only mislead whoever reads the
 * settings screen — and a hand-edited row must not make the panel throw.
 */
export function readEvents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && isWebhookEvent(v) && !out.includes(v)) out.push(v);
  }
  // Catalogue order, not the order they were stored in: the settings screen
  // lists them in this order and a stable rendering is worth the sort.
  return WEBHOOK_EVENT_IDS.filter((id) => out.includes(id));
}

export function labelFor(id: string): string {
  return WEBHOOK_EVENTS.find((e) => e.id === id)?.label ?? id;
}
