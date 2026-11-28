/**
 * Who reads a change to an existing Calendar event, for Guardian
 * (`audience` in `design/guardian.md`).
 */
import type {
  GuardianContext,
  GuardianResult,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain, readGoogleConfig } from "../config";
import { googleApiRequest } from "../google-api";
import { parseEventId } from "./events";

const attendeesSchema = z.object({
  attendees: z
    .array(z.object({ email: z.string(), resource: z.boolean().optional() }))
    .optional(),
});

/**
 * Google emails a change to every attendee, and guests can invite others,
 * so the event is `internal` only when Google lists no attendee outside the
 * company's Workspace domains. A room is not a reader. A bad reference or a
 * failed read counts as `world`.
 */
export async function eventGuardian(
  eventIdOrLink: string,
  ctx: GuardianContext,
): Promise<GuardianResult> {
  const target = `Google Calendar event ${eventIdOrLink}`;
  const allowedDomains = readGoogleConfig()?.allowedDomains;
  if (!allowedDomains) return { target, audience: "world" };
  try {
    const eventId = parseEventId(eventIdOrLink);
    const response = await googleApiRequest(ctx, {
      operation: "google.calendar.event.get",
      path: `/calendar/v3/calendars/primary/events/${eventId}`,
      query: { fields: "attendees(email,resource)" },
    });
    if (response.status !== 200) return { target, audience: "world" };
    const { attendees = [] } = attendeesSchema.parse(response.body);
    const outside = attendees.some(({ email, resource }) => {
      if (resource) return false;
      const domain = emailDomain(email);
      return !domain || !allowedDomains.includes(domain);
    });
    return { target, audience: outside ? "world" : "internal" };
  } catch {
    return { target, audience: "world" };
  }
}
