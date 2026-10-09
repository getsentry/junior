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
  ownEventIdSchema,
  ownEventSchema,
  readOwnEventForRequester,
  requireAllowedEmails,
  timeZoneSchema,
  type GoogleToolContext,
} from "./shared";

const inputSchema = z
  .object({
    eventId: ownEventIdSchema,
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
    location: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe(
        "Replacement location, such as a room name or address. Use an empty string to clear it.",
      ),
    addAttendees: emailListSchema(50)
      .default([])
      .describe("Email addresses to invite as required attendees."),
    addOptionalAttendees: emailListSchema(50)
      .default([])
      .describe("Email addresses to invite as optional attendees."),
    removeAttendees: emailListSchema(50)
      .default([])
      .describe("Email addresses to remove from the event."),
    addVideoCall: z
      .literal(true)
      .optional()
      .describe("Add a Google Meet link when the event has none."),
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
      input.location !== undefined ||
      input.addVideoCall !== undefined ||
      input.addAttendees.length > 0 ||
      input.addOptionalAttendees.length > 0 ||
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
 * Only people already invited to the event may change it.
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
        input.location !== undefined &&
          (input.location
            ? `set the location to ${input.location}`
            : "clear the location"),
        input.addVideoCall && "add a Google Meet link",
        input.addAttendees.length > 0 &&
          `invite ${input.addAttendees.join(", ")}`,
        input.addOptionalAttendees.length > 0 &&
          `invite ${input.addOptionalAttendees.join(", ")} as optional`,
        input.removeAttendees.length > 0 &&
          `remove ${input.removeAttendees.join(", ")}`,
      ].filter(Boolean);
      return `Update Google Calendar event ${input.eventId}: ${changes.join("; ")}. Attendees get an email about the change.`;
    },
    description:
      "Change a Google Calendar event organized by Junior's own Google account: title, description, time, location, video call, or attendees. Use it to reschedule, add or remove people, or fix details. Google emails the attendees about the change, and existing attendees keep their responses. Only people invited to the event can ask for changes, and only people in the company's Google Workspace domains can be invited. Junior cannot change events other people organize. For a repeating event, an occurrence id changes only that occurrence; its seriesEventId changes every occurrence. Confirm the change with the requester first unless they already stated it exactly.",
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
      requireAllowedEmails(
        [...input.addAttendees, ...input.addOptionalAttendees],
        ctx.allowedDomains,
      );
      const { event, path } = await readOwnEventForRequester(
        ctx,
        input.eventId,
        "change",
      );
      if (event.status === "cancelled") {
        throw new PluginToolInputError(
          "This event is cancelled. Create a new event instead.",
        );
      }
      const attendees = event.attendees ?? [];
      // Google can return directory capitalization; inputs are lowercased.
      const emailKey = (email: string) => email.toLowerCase();
      const removed = new Set(input.removeAttendees);
      const kept = attendees.filter(
        (attendee) => !removed.has(emailKey(attendee.email)),
      );
      const existing = new Set(
        kept.map((attendee) => emailKey(attendee.email)),
      );
      const added = [
        ...input.addAttendees.map((email) => ({ email })),
        ...input.addOptionalAttendees.map((email) => ({
          email,
          optional: true,
        })),
      ].filter((attendee) => {
        if (existing.has(attendee.email)) return false;
        existing.add(attendee.email);
        return true;
      });
      const attendeesChanged = kept.length !== attendees.length || added.length;
      const addVideoCall = input.addVideoCall && !event.hangoutLink;

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
          ...(input.location !== undefined && { location: input.location }),
          ...(attendeesChanged && { attendees: [...kept, ...added] }),
          ...(addVideoCall && {
            conferenceData: {
              createRequest: {
                conferenceSolutionKey: { type: "hangoutsMeet" },
                requestId: `${event.id}-meet`,
              },
            },
          }),
        },
        operation: "google.calendar.event.update",
        path,
        query: {
          ...(addVideoCall && { conferenceDataVersion: "1" }),
          sendUpdates: "all",
        },
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
