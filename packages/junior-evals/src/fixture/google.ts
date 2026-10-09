/**
 * Google Calendar for tests that run the agent with the Google plugin.
 *
 * `connectGoogleAccount()` stores the connection of Junior's Google account
 * through the plugin store. `mockGoogleCalendars()` answers the Google token,
 * free/busy, and event list APIs from calendars that repeat each week, so the
 * calendars are the same on each run date.
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
const TIME_ZONE = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** An event that repeats each week. Times are Pacific time, 24-hour `HH:MM`. */
export interface WeeklyEvent {
  end: string;
  start: string;
  title: string;
  weekdays: Array<(typeof WEEKDAYS)[number]>;
}

/** The calendar of one person, as Junior's Google account sees it. */
export interface MockCalendar {
  email: string;
  events: WeeklyEvent[];
}

/** Store the connection of Junior's Google account. */
export async function connectGoogleAccount(): Promise<void> {
  await saveGoogleAccount(getDb() as unknown as GoogleDb, {
    accountEmail: GOOGLE_ACCOUNT_EMAIL,
    connectedAtMs: Date.now(),
    connectedBy: "admin@example.com",
    refreshToken: "eval-google-refresh-token",
    scope: "calendar",
  });
}

/** The offset of Pacific time from UTC at one instant. */
function offsetMs(ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      timeZone: TIME_ZONE,
      year: "numeric",
    })
      .formatToParts(ms)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  return wall - Math.floor(ms / 60_000) * 60_000;
}

/** The instant of a Pacific time on a day, given as UTC midnight. */
function pacificMs(dayMs: number, clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  const wall = dayMs + hours * 3_600_000 + minutes * 60_000;
  // A second pass corrects the offset on days when it changes.
  return wall - offsetMs(wall - offsetMs(wall));
}

/** The events of a calendar that overlap one window, in start order. */
function occurrences(calendar: MockCalendar, timeMin: string, timeMax: string) {
  const minMs = Date.parse(timeMin);
  const maxMs = Date.parse(timeMax);
  const firstDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
  }).format(minMs);
  const found = [];
  for (
    let dayMs = Date.parse(`${firstDay}T00:00:00Z`);
    dayMs < maxMs + DAY_MS;
    dayMs += DAY_MS
  ) {
    const weekday = WEEKDAYS[new Date(dayMs).getUTCDay()];
    const date = new Date(dayMs).toISOString().slice(0, 10).replaceAll("-", "");
    for (const [index, event] of calendar.events.entries()) {
      const startMs = pacificMs(dayMs, event.start);
      const endMs = pacificMs(dayMs, event.end);
      if (
        event.weekdays.includes(weekday) &&
        endMs > minMs &&
        startMs < maxMs
      ) {
        found.push({
          end: new Date(endMs).toISOString(),
          id: `evt${index}_${date}`,
          start: new Date(startMs).toISOString(),
          title: event.title,
        });
      }
    }
  }
  return found.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Answer Google APIs from these calendars in the current test. Junior's
 * account cannot see a calendar that is not in the list.
 */
export function mockGoogleCalendars(calendars: MockCalendar[]): void {
  const find = (email: string) =>
    calendars.find((calendar) => calendar.email === email.toLowerCase());
  mswServer.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({
        access_token: "eval-google-access-token",
        expires_in: 3600,
      }),
    ),
    http.post(`${GOOGLE_API}/freeBusy`, async ({ request }) => {
      const body = (await request.json()) as {
        items: Array<{ id: string }>;
        timeMax: string;
        timeMin: string;
      };
      const entries = body.items.map(({ id }) => {
        const calendar = find(id);
        return [
          id,
          calendar
            ? {
                busy: occurrences(calendar, body.timeMin, body.timeMax).map(
                  ({ end, start }) => ({ end, start }),
                ),
              }
            : { busy: [], errors: [{ reason: "notFound" }] },
        ];
      });
      return HttpResponse.json({ calendars: Object.fromEntries(entries) });
    }),
    http.get(
      `${GOOGLE_API}/calendars/:calendarId/events`,
      ({ params, request }) => {
        const calendar = find(decodeURIComponent(String(params.calendarId)));
        if (!calendar) {
          return HttpResponse.json({}, { status: 404 });
        }
        const query = new URL(request.url).searchParams;
        const events = occurrences(
          calendar,
          query.get("timeMin") ?? "",
          query.get("timeMax") ?? "",
        );
        return HttpResponse.json({
          items: events.map((event) => ({
            end: { dateTime: event.end },
            id: event.id,
            start: { dateTime: event.start },
            summary: event.title,
          })),
        });
      },
    ),
  );
}
