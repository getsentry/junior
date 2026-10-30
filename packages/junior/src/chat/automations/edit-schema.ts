import { scheduleIntentSchema } from "@/chat/scheduled-automations/schedule-intent";
import {
  eventAutomationTriggerSchema,
  EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH,
} from "@/chat/event-automations/types";
import { taskOutcomeSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";

export const automationTitleSchema = z.string().trim().min(1).max(60);
export const automationInstructionSchema = z.string().trim().min(1).max(4000);

/**
 * Instruction input for agent tools. The run does not see the request, so the
 * instruction names who and what it means. Each run knows "the creator".
 */
export const automationInstructionToolSchema =
  automationInstructionSchema.describe(
    'Work to perform when the Automation runs. The run does not see this conversation, so words like "me" or "this conversation" will mean nothing then. Write who and what you mean. Call the person who created the Automation "the creator"; each run knows who that is. Name any other person with their Slack mention, such as <@U123>. Preserve the user\'s scope, targets, and constraints. Do not add permissions or side effects the user did not request.',
  );

export const automationEditFieldsSchema = z.object({
  title: automationTitleSchema.optional(),
  instruction: automationInstructionSchema.optional(),
  credentialMode: z.enum(["system", "creator"]).optional(),
  // A retained outcome can be kept or reordered, but cannot grant a new Destination.
  outcomes: z
    .array(z.union([taskOutcomeInputSchema, taskOutcomeSchema]))
    .max(5)
    .optional(),
});

export type AutomationEditFields = z.output<typeof automationEditFieldsSchema>;

export const scheduledAutomationEditSchema = automationEditFieldsSchema
  .extend({
    schedule: scheduleIntentSchema.optional(),
    status: z.enum(["active", "blocked"]).optional(),
  })
  .strict();

export const eventAutomationEditSchema = automationEditFieldsSchema
  .extend({
    trigger: eventAutomationTriggerSchema
      .safeExtend({
        identifier: z
          .string()
          .trim()
          .min(1)
          .max(EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH)
          .optional(),
        label: z.string().trim().min(1).max(500),
      })
      .optional(),
  })
  .strict();
