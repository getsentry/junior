import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { emailDomain } from "../config";
import { saveWorkingHours } from "../store";
import {
  clockMinutes,
  clockTimeSchema,
  requesterEmail,
  type GoogleToolContext,
} from "./shared";

const inputSchema = z
  .object({
    workdayStart: clockTimeSchema.describe(
      "Earliest local time the requester can meet, 24-hour HH:MM, in their own calendar time zone.",
    ),
    workdayEnd: clockTimeSchema.describe(
      "Latest local time the requester can meet, 24-hour HH:MM, in their own calendar time zone.",
    ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("setWorkingHours"),
  email: z.string(),
  workdayEnd: z.string(),
  workdayStart: z.string(),
});

/**
 * Save the requester's own working hours for `findMeetingTimes`.
 *
 * Google Calendar does not expose the working hours that people set in
 * Calendar, so people tell Junior instead. A requester can only change their
 * own hours.
 */
export function createSetWorkingHoursTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    describeProposal(input) {
      return `Save the requester's working hours as ${input.workdayStart}-${input.workdayEnd} on weekdays, in their calendar time zone. findMeetingTimes then offers them times only inside these hours.`;
    },
    description:
      "Save the requester's own working hours, the weekday hours when they can meet, in their own calendar time zone. findMeetingTimes uses them instead of the default 09:00-17:00 for this person, for every requester. Google Calendar does not share the working hours set in Calendar, so use this when the requester tells you their hours. It replaces hours saved before. It cannot change anyone else's hours.",
    inputSchema,
    outputSchema,
    async execute(input) {
      if (clockMinutes(input.workdayEnd) <= clockMinutes(input.workdayStart)) {
        throw new PluginToolInputError(
          "workdayEnd must be after workdayStart.",
        );
      }
      const email = await requesterEmail(ctx);
      const domain = email ? emailDomain(email) : undefined;
      if (!email || !domain || !ctx.allowedDomains.includes(domain)) {
        throw new PluginToolInputError(
          `Junior does not know the requester's work email at ${ctx.allowedDomains.join(", ")}, so it cannot save their working hours.`,
        );
      }
      await saveWorkingHours(ctx.db, email, input);
      return {
        target: "setWorkingHours" as const,
        email,
        workdayEnd: input.workdayEnd,
        workdayStart: input.workdayStart,
      };
    },
  });
}
