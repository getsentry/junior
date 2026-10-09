import { createHash, randomUUID } from "node:crypto";
import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  RECORDING_NOTICE,
  recordingOutputFields,
  turnOnAutoRecording,
} from "./meet-recording";
import {
  emailListSchema,
  googleApiError,
  googleApiRequest,
  MAX_EVENT_MS,
  ownEventOutputFields,
  ownEventResult,
  ownEventSchema,
  requireAllowedEmails,
  timeZoneSchema,
  withRequester,
  type GoogleToolContext,
} from "./shared";

const repeatSchema = z
  .object({
    frequency: z
      .enum(["weekdays", "weekly", "monthly"])
      .describe(
        "`weekdays` repeats Monday to Friday. `weekly` repeats on the start's weekday. `monthly` repeats on the start's day of the month.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(1)
      .describe(
        "Repeat every N weeks or months. 2 with `weekly` means every other week. Ignored for `weekdays`.",
      ),
    count: z
      .number()
      .int()
      .min(2)
      .max(200)
      .optional()
      .describe("Number of occurrences. Omit when the series has no end."),
  })
  .strict();

type Repeat = z.infer<typeof repeatSchema>;

/** Build the Google recurrence rule for a repeating event. Exported for tests. */
export function recurrenceRule(repeat: Repeat): string {
  const parts =
    repeat.frequency === "weekdays"
      ? ["FREQ=WEEKLY", "BYDAY=MO,TU,WE,TH,FR"]
      : [
          `FREQ=${repeat.frequency === "weekly" ? "WEEKLY" : "MONTHLY"}`,
          ...(repeat.interval > 1 ? [`INTERVAL=${repeat.interval}`] : []),
        ];
  if (repeat.count) parts.push(`COUNT=${repeat.count}`);
  return `RRULE:${parts.join(";")}`;
}

const inputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        'Specific title that says who and what, such as "Alice / Bob: Q4 hiring plan". Avoid generic titles such as "Meeting" or "Sync".',
      ),
    description: z
      .string()
      .max(4000)
      .optional()
      .describe(
        "Purpose, agenda, and links attendees need to prepare. Do not include private details the attendees should not see.",
      ),
    location: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("Room name or address for an in-person meeting."),
    start: z.iso
      .datetime({ offset: true })
      .describe("Event start, RFC 3339 with offset."),
    end: z.iso
      .datetime({ offset: true })
      .describe("Event end, RFC 3339 with offset."),
    timeZone: timeZoneSchema,
    attendees: emailListSchema(50).describe(
      "Email addresses of required attendees. Junior adds the requester automatically when it knows their email.",
    ),
    optionalAttendees: emailListSchema(50)
      .default([])
      .describe("Email addresses to invite as optional attendees."),
    repeat: repeatSchema
      .optional()
      .describe("Make a repeating series, such as a weekly 1:1."),
    record: z
      .boolean()
      .optional()
      .describe(
        "Turn on Google Meet auto-recording, for example for an incident postmortem. Set only when the requester asks to record. Junior adds a recording notice to the description.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("createCalendarEvent"),
  created: z.boolean(),
  ...ownEventOutputFields,
  ...recordingOutputFields,
});

/**
 * Derive a stable Calendar event id from the tool call.
 *
 * Google accepts client ids in base32hex (`a-v`, `0-9`). Hex is a subset, so a
 * retried tool call maps to the same event instead of a duplicate invite.
 */
export function calendarEventId(toolCallId: string | undefined): string {
  return createHash("sha256")
    .update(`junior-google:${toolCallId ?? randomUUID()}`)
    .digest("hex")
    .slice(0, 40);
}

/** Create an event on Junior's own calendar and invite the attendees. */
export function createCreateCalendarEventTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      const optional = input.optionalAttendees.length
        ? ` (optional: ${input.optionalAttendees.join(", ")})`
        : "";
      const repeat = input.repeat
        ? `, repeating ${recurrenceRule(input.repeat)}`
        : "";
      const record = input.record ? " with Google Meet auto-recording" : "";
      return `Create Google Calendar event "${input.title}" from ${input.start} to ${input.end}${repeat}${record} and email invites to ${input.attendees.join(", ") || "the requester"}${optional}.`;
    },
    description:
      "Create a Google Calendar event organized by Junior's own Google account and email invites to the attendees. Every event gets a Google Meet link. Junior can later change or cancel it. Use after the requester confirms the time, or when they already gave an exact time. Check the time with findMeetingTimes first unless the requester says to book it anyway. Only people in the company's Google Workspace domains can be invited.",
    inputSchema,
    outputSchema,
    async execute(input, options) {
      const timeZone = input.timeZone ?? (await ctx.users.resolveTimezone());
      const startMs = Date.parse(input.start);
      const endMs = Date.parse(input.end);
      if (endMs <= startMs) {
        throw new PluginToolInputError("end must be after start.");
      }
      if (endMs - startMs > MAX_EVENT_MS) {
        throw new PluginToolInputError("Events can be at most 8 hours long.");
      }
      const attendees = await withRequester(ctx, input.attendees);
      const required = new Set(attendees);
      const optionalAttendees = [...new Set(input.optionalAttendees)].filter(
        (email) => !required.has(email),
      );
      if (attendees.length + optionalAttendees.length === 0) {
        throw new PluginToolInputError("Invite at least one attendee.");
      }
      requireAllowedEmails(
        [...attendees, ...optionalAttendees],
        ctx.allowedDomains,
      );

      const description = input.record
        ? [input.description, RECORDING_NOTICE].filter(Boolean).join("\n\n")
        : input.description;
      const eventId = calendarEventId(options.toolCallId);
      const response = await googleApiRequest(ctx, {
        body: {
          attendees: [
            ...attendees.map((email) => ({ email })),
            ...optionalAttendees.map((email) => ({ email, optional: true })),
          ],
          conferenceData: {
            createRequest: {
              conferenceSolutionKey: { type: "hangoutsMeet" },
              requestId: eventId,
            },
          },
          ...(description ? { description } : undefined),
          end: { dateTime: input.end, timeZone },
          guestsCanModify: false,
          id: eventId,
          ...(input.location ? { location: input.location } : undefined),
          ...(input.repeat
            ? { recurrence: [recurrenceRule(input.repeat)] }
            : undefined),
          start: { dateTime: input.start, timeZone },
          summary: input.title,
        },
        operation: "google.calendar.event.create",
        path: "/calendar/v3/calendars/primary/events",
        query: {
          conferenceDataVersion: "1",
          sendUpdates: "all",
        },
      });

      let created = true;
      let event = response;
      if (response.status === 409) {
        // A retry of the same tool call already created this event.
        created = false;
        event = await googleApiRequest(ctx, {
          operation: "google.calendar.event.get",
          path: `/calendar/v3/calendars/primary/events/${eventId}`,
        });
        if (event.status !== 200) {
          throw googleApiError("google.calendar.event.get", event);
        }
      } else if (response.status !== 200) {
        throw googleApiError("google.calendar.event.create", response);
      }

      const ownEvent = ownEventSchema.parse(event.body);
      return {
        target: "createCalendarEvent" as const,
        created,
        ...ownEventResult(ownEvent, timeZone),
        ...(input.record
          ? await turnOnAutoRecording(ctx, ownEvent)
          : undefined),
      };
    },
  });
}
