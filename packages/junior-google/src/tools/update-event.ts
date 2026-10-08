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
  requesterEmail,
  requireAllowedEmails,
  timeZoneSchema,
  type GoogleToolContext,
} from "./shared";

const inputSchema = z
  .object({
    eventId: z
      .string()
      .regex(/^[A-Za-z0-9_]{5,1024}$/, "Use an event id from a Calendar tool")
      .describe(
        "Event id from createCalendarEvent or listCalendarEvents. Only events that Junior organizes can be changed.",
      ),
    title: z.string().trim().min(1).max(200).optional(),
    description: z
      .string()
      .max(4000)
      .optional()
      .describe(
        "Replacement description. Do not include private details the attendees should not see.",
      ),
    start: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("New start, RFC 3339 with offset. Give end too."),
    end: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("New end, RFC 3339 with offset. Give start too."),
    timeZone: timeZoneSchema,
    addAttendees: emailListSchema(50)
      .default([])
      .describe("Email addresses to invite."),
    removeAttendees: emailListSchema(50)
      .default([])
      .describe("Email addresses to remove from the event."),
  })
  .strict()
  .refine(
    (input) => (input.start === undefined) === (input.end === undefined),
    {
      message: "Give both start and end to move an event.",
    },
  )
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.start !== undefined ||
      input.addAttendees.length > 0 ||
      input.removeAttendees.length > 0,
    { message: "Give at least one change." },
  );

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("updateCalendarEvent"),
  ...ownEventOutputFields,
});

/**
 * Change an event that Junior organizes and email the attendees.
 *
 * Only people already invited to the event may change it. This keeps one
 * requester from moving or rewriting a meeting that Junior set up for others.
 */
export function createUpdateCalendarEventTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      const changes = [
        input.title && `rename it to "${input.title}"`,
        input.start && `move it to ${input.start} – ${input.end}`,
        input.description !== undefined && "replace the description",
        input.addAttendees.length > 0 &&
          `invite ${input.addAttendees.join(", ")}`,
        input.removeAttendees.length > 0 &&
          `remove ${input.removeAttendees.join(", ")}`,
      ].filter(Boolean);
      return `Update Google Calendar event ${input.eventId}: ${changes.join("; ")}. Attendees get an email about the change.`;
    },
    description:
      "Change a Google Calendar event organized by Junior's own Google account: title, description, time, or attendees. Google emails the attendees about the change. Only people invited to the event can ask for changes, and only people in the company's Google Workspace domains can be invited. Use after the requester confirms the change.",
    inputSchema,
    outputSchema,
    async execute(input) {
      if (input.start && input.end) {
        const durationMs = Date.parse(input.end) - Date.parse(input.start);
        if (durationMs <= 0) {
          throw new PluginToolInputError("end must be after start.");
        }
        if (durationMs > MAX_EVENT_MS) {
          throw new PluginToolInputError("Events can be at most 8 hours long.");
        }
      }
      requireAllowedEmails(input.addAttendees, ctx.allowedDomains);
      const requester = await requesterEmail(ctx);
      if (!requester) {
        throw new PluginToolInputError(
          "Junior does not know the requester's email, so it cannot check that they may change this event.",
        );
      }

      const path = `/calendar/v3/calendars/primary/events/${input.eventId}`;
      const current = await googleApiRequest(ctx, {
        operation: "google.calendar.event.get",
        path,
      });
      if (current.status === 404) {
        throw new PluginToolInputError(
          `Junior's calendar has no event ${input.eventId}.`,
        );
      }
      if (current.status !== 200) {
        throw googleApiError("google.calendar.event.get", current);
      }
      const event = ownEventSchema.parse(current.body);
      if (event.organizer?.self !== true) {
        throw new PluginToolInputError(
          "Junior does not organize this event, so it cannot change it.",
        );
      }
      const attendees = event.attendees ?? [];
      // Google can return directory capitalization; inputs are lowercased.
      const emailKey = (email: string) => email.toLowerCase();
      if (
        !attendees.some((attendee) => emailKey(attendee.email) === requester)
      ) {
        throw new PluginToolInputError(
          "Only people invited to this event can ask Junior to change it.",
        );
      }

      const removed = new Set(input.removeAttendees);
      const kept = attendees.filter(
        (attendee) => !removed.has(emailKey(attendee.email)),
      );
      const existing = new Set(
        kept.map((attendee) => emailKey(attendee.email)),
      );
      const added = input.addAttendees
        .filter((email) => !existing.has(email))
        .map((email) => ({ email }));
      const attendeesChanged = kept.length !== attendees.length || added.length;

      const response = await googleApiRequest(ctx, {
        body: {
          ...(input.title !== undefined && { summary: input.title }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.start &&
            input.end && {
              end: { dateTime: input.end, timeZone: input.timeZone },
              start: { dateTime: input.start, timeZone: input.timeZone },
            }),
          ...(attendeesChanged && { attendees: [...kept, ...added] }),
        },
        operation: "google.calendar.event.update",
        path,
        query: { sendUpdates: "all" },
      });
      if (response.status !== 200) {
        throw googleApiError("google.calendar.event.update", response);
      }
      return {
        target: "updateCalendarEvent" as const,
        ...ownEventResult(ownEventSchema.parse(response.body), input.timeZone),
      };
    },
  });
}
