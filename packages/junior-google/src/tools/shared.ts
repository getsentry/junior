import {
  PluginToolInputError,
  type PluginEgress,
  type User,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { calendarEventAnnotation } from "../annotations";
import { emailDomain } from "../config";
import {
  GOOGLE_API_DOMAIN,
  GOOGLE_OPERATIONS,
  type GoogleOperation,
} from "../credentials";

/** Runtime capabilities the Calendar tools use. */
export interface GoogleToolContext {
  allowedDomains: string[];
  egress: PluginEgress;
  users: {
    resolveActor(): Promise<{ user?: User } | undefined>;
  };
}

export const emailListSchema = (max: number) =>
  z
    .array(z.string().trim().toLowerCase().pipe(z.email()))
    .max(max)
    .describe("Attendee email addresses.");

export const timeZoneSchema = z
  .string()
  .min(1)
  .refine(isTimeZone, "timeZone must be an IANA time zone")
  .describe(
    "IANA time zone used to read and show times, such as America/Los_Angeles.",
  );

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Reject people outside the domains Junior may look up or invite. */
export function requireAllowedEmails(
  emails: string[],
  allowedDomains: string[],
): void {
  const outside = emails.filter((email) => {
    const domain = emailDomain(email);
    return !domain || !allowedDomains.includes(domain);
  });
  if (outside.length > 0) {
    throw new PluginToolInputError(
      `Junior can only schedule with people at ${allowedDomains.join(", ")}. Not allowed: ${outside.join(", ")}`,
    );
  }
}

/** Return the requester's email in lowercase, when Junior knows it. */
export async function requesterEmail(
  ctx: GoogleToolContext,
): Promise<string | undefined> {
  return (await ctx.users.resolveActor())?.user?.email?.trim().toLowerCase();
}

/**
 * Add the requester's email when Junior knows it and it is in an allowed
 * domain. People rarely type their own address.
 */
export async function withRequester(
  ctx: GoogleToolContext,
  emails: string[],
): Promise<string[]> {
  const requester = await requesterEmail(ctx);
  const domain = requester ? emailDomain(requester) : undefined;
  const all =
    requester && domain && ctx.allowedDomains.includes(domain)
      ? [requester, ...emails]
      : emails;
  return [...new Set(all)];
}

const googleErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

/** Call one Google Calendar API operation through host-owned egress. */
export async function googleApiRequest(
  ctx: GoogleToolContext,
  input: {
    body?: unknown;
    operation: GoogleOperation;
    path: string;
    query?: Record<string, string>;
  },
): Promise<{ body: unknown; status: number }> {
  const url = new URL(`https://${GOOGLE_API_DOMAIN}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await ctx.egress.fetch({
    operation: input.operation,
    provider: "google",
    request: new Request(url, {
      method: GOOGLE_OPERATIONS[input.operation].method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { body, status: response.status };
}

/** Turn a failed Google response into a tool error. */
export function googleApiError(
  operation: GoogleOperation,
  response: { body: unknown; status: number },
): Error {
  const parsed = googleErrorSchema.safeParse(response.body);
  const detail = parsed.success ? parsed.data.error?.message : undefined;
  const message = `Google ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
  return response.status === 400
    ? new PluginToolInputError(message)
    : new Error(message);
}

/** Format one interval for people, in the requested time zone. */
export function formatInterval(
  startMs: number,
  endMs: number,
  timeZone: string,
): string {
  const day = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone,
    weekday: "short",
  }).format(startMs);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return `${day}, ${time.format(startMs)} – ${time.format(endMs)}`;
}

/** Longest event Junior may create or move an event to. */
export const MAX_EVENT_MS = 8 * 60 * 60 * 1000;

/** Event fields that Junior reads back from its own calendar. */
export const ownEventSchema = z.object({
  attendees: z
    .array(
      z
        .object({ email: z.string(), responseStatus: z.string().optional() })
        .loose(),
    )
    .optional(),
  description: z.string().optional(),
  end: z.object({ dateTime: z.string() }),
  hangoutLink: z.string().optional(),
  htmlLink: z.string().optional(),
  id: z.string(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
  start: z.object({ dateTime: z.string() }),
  summary: z.string().optional(),
  // Annotation metadata only. Do not fail a completed change on a bad value.
  updated: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

/**
 * Shape one event on Junior's calendar for a tool result.
 *
 * The result includes the event annotation, so core saves it on the
 * Conversation and shows its card with the next reply.
 */
export function ownEventResult(
  event: z.infer<typeof ownEventSchema>,
  timeZone: string,
) {
  const label = formatInterval(
    Date.parse(event.start.dateTime),
    Date.parse(event.end.dateTime),
    timeZone,
  );
  const annotation = calendarEventAnnotation({
    description: event.description,
    eventId: event.id,
    label,
    sourceUpdatedAt: event.updated,
    title: event.summary,
    url: event.htmlLink,
  });
  return {
    ...(annotation && { objectAnnotations: [annotation] }),
    attendees: (event.attendees ?? []).map((attendee) => attendee.email),
    end: event.end.dateTime,
    eventId: event.id,
    label,
    start: event.start.dateTime,
    ...(event.summary ? { title: event.summary } : undefined),
    ...(event.htmlLink ? { url: event.htmlLink } : undefined),
    ...(event.hangoutLink ? { videoCallUrl: event.hangoutLink } : undefined),
  };
}

/** Output fields shared by the tools that create or change Junior's events. */
export const ownEventOutputFields = {
  attendees: z.array(z.string()),
  end: z.string(),
  eventId: z.string(),
  label: z.string(),
  start: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  videoCallUrl: z.string().optional(),
};
