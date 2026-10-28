import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  googleApiError,
  googleApiRequest,
  ownEventIdSchema,
  ownEventOutputFields,
  ownEventResult,
  readOwnEventForRequester,
  timeZoneSchema,
  type GoogleToolContext,
} from "./shared";

const inputSchema = z
  .object({
    eventId: ownEventIdSchema,
    timeZone: timeZoneSchema,
  })
  .strict();

// An event that was already cancelled has no details to return.
const outputSchema = pluginToolOutputSchema
  .extend({
    target: z.literal("cancelCalendarEvent"),
    cancelled: z
      .boolean()
      .describe(
        "False when the event was already cancelled before this call. Event details are then missing.",
      ),
    ...ownEventOutputFields,
  })
  .partial({ attendees: true, end: true, label: true, start: true });

/**
 * Cancel an event that Junior organizes and email the attendees.
 *
 * Junior can only delete events on its own calendar, and only for a requester
 * who is invited. Events that other people organize stay out of reach: the
 * `calendar.events.owned` scope and the organizer check both enforce this.
 */
export function createCancelCalendarEventTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      return `Cancel Google Calendar event ${input.eventId} organized by Junior. Google emails every attendee a cancellation.`;
    },
    description:
      "Cancel a Google Calendar event organized by Junior's own Google account. Google removes it from every attendee's calendar and emails them a cancellation. Only people invited to the event can ask to cancel it. Junior cannot cancel events other people organize. For a repeating event, an occurrence id cancels only that occurrence; its seriesEventId cancels every occurrence. Confirm which event, and for a repeating event whether one occurrence or the series, unless the requester already made it clear.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const timeZone = input.timeZone ?? (await ctx.users.resolveTimezone());
      const read = await readOwnEventForRequester(ctx, input.eventId, "cancel");
      if (read.status === "cancelled") {
        return {
          target: "cancelCalendarEvent" as const,
          cancelled: false,
          eventId: read.eventId,
        };
      }
      const { event, path } = read;
      const result = {
        target: "cancelCalendarEvent" as const,
        ...ownEventResult(event, timeZone),
      };

      const response = await googleApiRequest(ctx, {
        operation: "google.calendar.event.delete",
        path,
        query: { sendUpdates: "all" },
      });
      // 410 means a retry of this call already deleted the event.
      if (response.status !== 204 && response.status !== 410) {
        throw googleApiError("google.calendar.event.delete", response);
      }
      return {
        ...result,
        // Keep the card in the Conversation, and show that the event is gone.
        objectAnnotations: result.objectAnnotations.map((annotation) => ({
          ...annotation,
          status: "cancelled",
        })),
        cancelled: response.status === 204,
      };
    },
  });
}
