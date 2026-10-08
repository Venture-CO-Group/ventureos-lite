/**
 * Google Calendar provider adapter (spec §4.8). Real Google Calendar in
 * production (per-user OAuth tokens), a mock in dev/test. Booking creates the
 * event on the host's (Tamas's) calendar with lead context attached; the brief
 * link is attached later via updateEventDescription.
 *
 * The provider owns token refresh and returns any refreshed credentials so the
 * caller can persist them back to GoogleCredential.
 */
import { refreshGoogleAccessToken } from "@/modules/google/clients";

export interface CalendarCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null;
  calendarId: string | null;
  /** The OAuth client that issued these tokens; a refresh must use it. */
  clientRef?: string | null;
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  startISO: string;
  endISO: string;
  attendees?: string[];
  timeZone?: string;
}

export interface CalendarEventResult {
  eventId: string;
  htmlLink: string | null;
}

export interface CalendarWrite {
  result: CalendarEventResult;
  refreshed?: Partial<CalendarCredentials>;
}

export interface BusyPeriod {
  startMs: number;
  endMs: number;
}

export interface FreeBusyResult {
  busy: BusyPeriod[];
  refreshed?: Partial<CalendarCredentials>;
}

export interface CalendarProvider {
  readonly name: string;
  createEvent(
    creds: CalendarCredentials,
    input: CalendarEventInput,
  ): Promise<CalendarWrite>;
  updateEventDescription(
    creds: CalendarCredentials,
    eventId: string,
    description: string,
  ): Promise<{ refreshed?: Partial<CalendarCredentials> }>;
  freeBusy(
    creds: CalendarCredentials,
    range: { startMs: number; endMs: number },
  ): Promise<FreeBusyResult>;
}

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";

  /** Ensure a live access token, refreshing if expired. Returns fresh creds. */
  private async ensureToken(
    creds: CalendarCredentials,
  ): Promise<{ accessToken: string; refreshed?: Partial<CalendarCredentials> }> {
    const stillValid =
      creds.expiryDate != null && creds.expiryDate.getTime() > Date.now() + 60_000;
    if (stillValid) return { accessToken: creds.accessToken };
    if (!creds.refreshToken) {
      // No way to refresh — surface as a calendar failure (lands in Today Queue).
      throw new Error("google_calendar_not_connected");
    }
    // With the client that issued the token, not the env one (see
    // modules/google/clients.ts).
    const { accessToken, expiryDate } = await refreshGoogleAccessToken({
      refreshToken: creds.refreshToken,
      clientRef: creds.clientRef,
    });
    return { accessToken, refreshed: { accessToken, expiryDate } };
  }

  async createEvent(
    creds: CalendarCredentials,
    input: CalendarEventInput,
  ): Promise<CalendarWrite> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const calId = encodeURIComponent(creds.calendarId ?? "primary");
    const tz = input.timeZone ?? "Europe/Budapest";
    const res = await fetch(`${CAL_BASE}/${calId}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startISO, timeZone: tz },
        end: { dateTime: input.endISO, timeZone: tz },
        attendees: (input.attendees ?? []).map((email) => ({ email })),
      }),
    });
    if (!res.ok) throw new Error(`google_calendar ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { id: string; htmlLink?: string };
    return { result: { eventId: data.id, htmlLink: data.htmlLink ?? null }, refreshed };
  }

  async updateEventDescription(
    creds: CalendarCredentials,
    eventId: string,
    description: string,
  ): Promise<{ refreshed?: Partial<CalendarCredentials> }> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const calId = encodeURIComponent(creds.calendarId ?? "primary");
    const res = await fetch(`${CAL_BASE}/${calId}/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description }),
    });
    if (!res.ok) throw new Error(`google_calendar_patch ${res.status}: ${await res.text()}`);
    return { refreshed };
  }

  async freeBusy(
    creds: CalendarCredentials,
    range: { startMs: number; endMs: number },
  ): Promise<FreeBusyResult> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const calId = creds.calendarId ?? "primary";
    const res = await fetch(FREEBUSY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: new Date(range.startMs).toISOString(),
        timeMax: new Date(range.endMs).toISOString(),
        items: [{ id: calId }],
      }),
    });
    if (!res.ok) throw new Error(`google_freebusy ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    };
    const periods = data.calendars?.[calId]?.busy ?? [];
    return {
      busy: periods.map((b) => ({
        startMs: Date.parse(b.start),
        endMs: Date.parse(b.end),
      })),
      refreshed,
    };
  }
}

class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock";
  async createEvent(
    _creds: CalendarCredentials,
    input: CalendarEventInput,
  ): Promise<CalendarWrite> {
    const eventId = `mock-evt-${input.startISO.replace(/[^0-9]/g, "").slice(0, 14)}`;
    // eslint-disable-next-line no-console
    console.log(`[calendar:mock] create "${input.summary}" @ ${input.startISO}`);
    return {
      result: { eventId, htmlLink: `https://calendar.google.com/mock/${eventId}` },
    };
  }
  async updateEventDescription(): Promise<{ refreshed?: Partial<CalendarCredentials> }> {
    return {};
  }
  async freeBusy(): Promise<FreeBusyResult> {
    // Dev/test: nothing busy — every configured slot is offered.
    return { busy: [] };
  }
}

let provider: CalendarProvider | null = null;
export function getCalendarProvider(): CalendarProvider {
  if (!provider) {
    const which = (process.env.CALENDAR_PROVIDER ?? "").toLowerCase();
    const useGoogle =
      which === "google" || (which === "" && !!process.env.GOOGLE_CLIENT_ID);
    provider = useGoogle ? new GoogleCalendarProvider() : new MockCalendarProvider();
  }
  return provider;
}

/** Test seam. */
export function __setCalendarProvider(p: CalendarProvider | null) {
  provider = p;
}
