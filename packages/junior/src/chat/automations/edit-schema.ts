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
 * Instruction input for agent tools. An Automation runs later without the
 * request around it, so a reference to that request, such as "this channel",
 * must become the exact target. "Me" and "my" stay as written, because each
 * run binds them to the creator identity. Other people need an exact mention.
 */
export const automationInstructionToolSchema =
  automationInstructionSchema.describe(
    'Work to perform when the Automation runs. The run does not see this conversation, so the instruction must make sense without it. Replace each reference to this conversation, such as "this channel", "here", "this thread", or "that PR", with the exact target, such as <#C123>, a link, or an ID. Keep "me" and "my" where they mean the Automation creator; each run binds them to the creator. Name every other person with their Slack mention, such as <@U123>, including a requester who is not the creator. Preserve the user\'s scope, targets, and constraints. Do not add permissions or side effects the user did not request.',
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
