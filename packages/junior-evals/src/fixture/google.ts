/**
 * Google Calendar for tests that run the agent with the Google plugin.
 *
 * `connectGoogleAccount()` stores the connection of Junior's own Google
 * account through the plugin store, as an admin sign-in does.
 * `mockGoogleCalendars()` answers the Google token, free/busy, and event list
 * APIs from weekly calendars. Busy blocks and events come from the window of
 * each request, so the calendars have the same shape on each run date.
 */
import { http, HttpResponse } from "msw";
import { getDb } from "@/chat/db";
import { mswServer } from "@junior-tests/msw/server";
import {
  saveGoogleAccount,
  type GoogleDb,
} from "../../../junior-google/src/store";
import { GOOGLE_ACCOUNT_EMAIL } from "../suites/google";

const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = [
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.readonly",
].join(" ");
const DAY_MS = 24 * 60 * 60 * 1000;

type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

/** An event that repeats each week at the same local time. */
export interface WeeklyEvent {
  /** Local end time, 24-hour `HH:MM`. */
  end: string;
  /** Local start time, 24-hour `HH:MM`. */
  start: string;
  title: string;
  weekdays: Weekday[];
}

/** The calendar of one person, as Junior's Google account sees it. */
export interface MockCalendar {
  email: string;
  events: WeeklyEvent[];
  /** IANA time zone of the event times, such as `America/Los_Angeles`. */
  timeZone: string;
}

/**
 * Store the connection of Junior's Google account. The Calendar tools then
 * get an access token from the mocked token endpoint.
 */
export async function connectGoogleAccount(): Promise<void> {
  await saveGoogleAccount(getDb() as unknown as GoogleDb, {
    accountEmail: GOOGLE_ACCOUNT_EMAIL,
    connectedAtMs: Date.now(),
    connectedBy: "admin@example.com",
    refreshToken: "eval-google-refresh-token",
    scope: CALENDAR_SCOPE,
  });
}

interface Occurrence {
  endMs: number;
  id: string;
  startMs: number;
  title: string;
}

function localDay(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      weekday: "short",
      year: "numeric",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: parts.weekday as Weekday,
    year: Number(parts.year),
  };
}

/** The offset of `timeZone` from UTC at one instant, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant of one local wall-clock time in `timeZone`. */
function localTimeMs(
  day: { day: number; month: number; year: number },
  clock: string,
  timeZone: string,
): number {
  const [hours, minutes] = clock.split(":").map(Number);
  const wall = Date.UTC(day.year, day.month - 1, day.day, hours, minutes);
  const guess = wall - zoneOffsetMs(wall, timeZone);
  // A second pass corrects the guess on days when the offset changes.
  return wall - zoneOffsetMs(guess, timeZone);
}

/** The occurrences of a weekly calendar that overlap one window. */
function occurrences(
  calendar: MockCalendar,
  timeMinMs: number,
  timeMaxMs: number,
): Occurrence[] {
  const found: Occurrence[] = [];
  for (let ms = timeMinMs - DAY_MS; ms <= timeMaxMs + DAY_MS; ms += DAY_MS) {
    const day = localDay(ms, calendar.timeZone);
    calendar.events.forEach((event, index) => {
      if (!event.weekdays.includes(day.weekday)) return;
      const startMs = localTimeMs(day, event.start, calendar.timeZone);
      const endMs = localTimeMs(day, event.end, calendar.timeZone);
      if (endMs <= timeMinMs || startMs >= timeMaxMs) return;
      const date = `${day.year}${String(day.month).padStart(2, "0")}${String(day.day).padStart(2, "0")}`;
      const id = `evt${index}_${date}`;
      if (found.some((item) => item.id === id)) return;
      found.push({ endMs, id, startMs, title: event.title });
    });
  }
  return found.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Answer Google APIs from these calendars in the current test. A calendar
 * that is not in the list is one that Junior's account cannot see.
 */
export function mockGoogleCalendars(calendars: MockCalendar[]): void {
  const byEmail = new Map(
    calendars.map((calendar) => [calendar.email.toLowerCase(), calendar]),
  );
  mswServer.use(
    http.post(GOOGLE_TOKEN_ENDPOINT, () =>
      HttpResponse.json({
        access_token: "eval-google-access-token",
        expires_in: 3600,
        scope: CALENDAR_SCOPE,
        token_type: "Bearer",
      }),
    ),
    http.post(`${GOOGLE_API}/freeBusy`, async ({ request }) => {
      const body = (await request.json()) as {
        items: Array<{ id: string }>;
        timeMax: string;
        timeMin: string;
      };
      const timeMinMs = Date.parse(body.timeMin);
      const timeMaxMs = Date.parse(body.timeMax);
      return HttpResponse.json({
        calendars: Object.fromEntries(
          body.items.map(({ id }) => {
            const calendar = byEmail.get(id.toLowerCase());
            if (!calendar) {
              return [id, { busy: [], errors: [{ reason: "notFound" }] }];
            }
            return [
              id,
              {
                busy: occurrences(calendar, timeMinMs, timeMaxMs).map(
                  (item) => ({
                    end: new Date(item.endMs).toISOString(),
                    start: new Date(item.startMs).toISOString(),
                  }),
                ),
              },
            ];
          }),
        ),
        kind: "calendar#freeBusy",
        timeMax: body.timeMax,
        timeMin: body.timeMin,
      });
    }),
    http.get(
      `${GOOGLE_API}/calendars/:calendarId/events`,
      ({ params, request }) => {
        const email = decodeURIComponent(String(params.calendarId));
        const calendar = byEmail.get(email.toLowerCase());
        if (!calendar) {
          return HttpResponse.json(
            { error: { code: 404, message: "Not Found" } },
            { status: 404 },
          );
        }
        const query = new URL(request.url).searchParams;
        const maxResults = Number(query.get("maxResults") ?? "250");
        const all = occurrences(
          calendar,
          Date.parse(query.get("timeMin") ?? ""),
          Date.parse(query.get("timeMax") ?? ""),
        );
        return HttpResponse.json({
          items: all.slice(0, maxResults).map((item) => ({
            end: { dateTime: new Date(item.endMs).toISOString() },
            id: item.id,
            organizer: { email: calendar.email },
            start: { dateTime: new Date(item.startMs).toISOString() },
            status: "confirmed",
            summary: item.title,
          })),
          ...(all.length > maxResults
            ? { nextPageToken: "eval-next-page" }
            : undefined),
        });
      },
    ),
  );
}
