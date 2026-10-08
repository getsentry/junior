import { createHash, randomUUID } from "node:crypto";
import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
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

const inputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z
      .string()
      .max(4000)
      .optional()
      .describe(
        "Event description. Do not include private details the attendees should not see.",
      ),
    start: z.iso
      .datetime({ offset: true })
      .describe("Event start, RFC 3339 with offset."),
    end: z.iso
      .datetime({ offset: true })
      .describe("Event end, RFC 3339 with offset."),
    timeZone: timeZoneSchema,
    attendees: emailListSchema(50).describe(
      "Email addresses to invite. Junior adds the requester automatically when it knows their email.",
    ),
    addVideoCall: z.boolean().default(true).describe("Add a Google Meet link."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("createCalendarEvent"),
  created: z.boolean(),
  ...ownEventOutputFields,
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
      return `Create Google Calendar event "${input.title}" from ${input.start} to ${input.end} and email invites to ${input.attendees.join(", ") || "the requester"}.`;
    },
    description:
      "Create a Google Calendar event organized by Junior's own Google account and email invites to the attendees. Use after the requester confirms the time. Only people in the company's Google Workspace domains can be invited.",
    inputSchema,
    outputSchema,
    async execute(input, options) {
      const startMs = Date.parse(input.start);
      const endMs = Date.parse(input.end);
      if (endMs <= startMs) {
        throw new PluginToolInputError("end must be after start.");
      }
      if (endMs - startMs > MAX_EVENT_MS) {
        throw new PluginToolInputError("Events can be at most 8 hours long.");
      }
      const attendees = await withRequester(ctx, input.attendees);
      if (attendees.length === 0) {
        throw new PluginToolInputError("Invite at least one attendee.");
      }
      requireAllowedEmails(attendees, ctx.allowedDomains);

      const eventId = calendarEventId(options.toolCallId);
      const response = await googleApiRequest(ctx, {
        body: {
          attendees: attendees.map((email) => ({ email })),
          ...(input.addVideoCall
            ? {
                conferenceData: {
                  createRequest: {
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                    requestId: eventId,
                  },
                },
              }
            : undefined),
          ...(input.description
            ? { description: input.description }
            : undefined),
          end: { dateTime: input.end, timeZone: input.timeZone },
          guestsCanModify: false,
          id: eventId,
          start: { dateTime: input.start, timeZone: input.timeZone },
          summary: input.title,
        },
        operation: "google.calendar.event.create",
        path: "/calendar/v3/calendars/primary/events",
        query: {
          conferenceDataVersion: input.addVideoCall ? "1" : "0",
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

      return {
        target: "createCalendarEvent" as const,
        created,
        ...ownEventResult(ownEventSchema.parse(event.body), input.timeZone),
      };
    },
  });
}
