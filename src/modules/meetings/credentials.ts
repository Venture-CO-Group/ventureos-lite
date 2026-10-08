import { prismaUnsafe } from "@/lib/db";
import type { CalendarCredentials } from "./calendar";

/**
 * Google accounts connected by a host.
 *
 * A host connects one account meetings are written to (purpose WRITE) and any
 * number of others that only contribute busy times (BUSY_ONLY) — typically a
 * personal calendar, so nobody books over a dentist appointment without that
 * calendar's contents ever being touched or shown.
 *
 * google_credentials is keyed by user, not workspace, so these go through
 * prismaUnsafe deliberately: every function here scopes by the userId it is
 * given, and callers pass the host of the booking page or the signed-in user.
 */
export const WRITE = "WRITE";
export const BUSY_ONLY = "BUSY_ONLY";

export interface CalendarAccount {
  id: string;
  accountEmail: string | null;
  purpose: string;
  scope: string | null;
  calendarId: string | null;
  creds: CalendarCredentials;
}

function toAccount(row: {
  id: string;
  accountEmail: string | null;
  purpose: string;
  scope: string | null;
  calendarId: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null;
  clientRef: string | null;
}): CalendarAccount {
  return {
    id: row.id,
    accountEmail: row.accountEmail,
    purpose: row.purpose,
    scope: row.scope,
    calendarId: row.calendarId,
    creds: {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiryDate: row.expiryDate,
      calendarId: row.calendarId,
      clientRef: row.clientRef,
    },
  };
}

/** Every connected account, write target first. */
export async function listCalendarAccounts(userId: string): Promise<CalendarAccount[]> {
  const rows = await prismaUnsafe.googleCredential.findMany({
    // A credential whose client was replaced cannot refresh; it is shown as
    // "reconnect" in settings, never used.
    where: { userId, invalidatedAt: null },
    orderBy: [{ purpose: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toAccount);
}

/**
 * The account meetings are written to. Falls back to any connected account so
 * a host who somehow has only BUSY_ONLY rows still gets their events created
 * rather than silently losing them.
 */
export async function getWriteAccount(userId: string): Promise<CalendarAccount | null> {
  const rows = await prismaUnsafe.googleCredential.findMany({
    where: { userId, invalidatedAt: null },
    orderBy: [{ createdAt: "asc" }],
  });
  if (rows.length === 0) return null;
  const write = rows.find((r) => r.purpose === WRITE) ?? rows[0];
  return toAccount(write);
}

/**
 * Every account whose events should block a slot — which is all of them. The
 * business calendar's own meetings count just as much as the personal one's.
 */
export async function getBusyAccounts(userId: string): Promise<CalendarAccount[]> {
  return listCalendarAccounts(userId);
}

/** Persist tokens Google handed back during a refresh. */
export async function saveRefreshedTokens(
  credentialId: string,
  refreshed: Partial<CalendarCredentials>,
): Promise<void> {
  await prismaUnsafe.googleCredential.update({
    where: { id: credentialId },
    data: {
      ...(refreshed.accessToken ? { accessToken: refreshed.accessToken } : {}),
      ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      ...(refreshed.expiryDate !== undefined ? { expiryDate: refreshed.expiryDate } : {}),
    },
  });
}
