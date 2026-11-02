import { scheduleIntentSchema } from "@/chat/scheduled-automations/schedule-intent";
import {
  eventMatchSchema,
  eventTypeSchema,
  taskOutcomeSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";

export const automationTitleSchema = z.string().trim().min(1).max(60);
export const automationInstructionSchema = z.string().trim().min(1).max(4000);

/**
 * Instruction input for agent tools. The run does not see the request, so the
 * instruction names exact targets. It calls the creator "the Automation
 * creator". It names every other person with their mention.
 */
export const automationInstructionToolSchema =
  automationInstructionSchema.describe(
    'Work to perform when the Automation runs. The run does not see this conversation, so words like "this channel" or "here" will mean nothing then. Write the exact target instead, such as a channel mention or a link. Call the person who created the Automation "the Automation creator", not "me"; each run knows who that is. Name every other person with their Slack mention, such as <@U123>, including a requester who did not create the Automation. Preserve the user\'s scope, targets, and constraints. Do not add permissions or side effects the user did not request.',
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

/**
 * A trigger in an edit. It has no identifier: its filters select the
 * resources. A saved trigger can still have an identifier until the upgrade
 * converts it, so read schemas keep that field.
 */
export const eventAutomationTriggerEditSchema = z
  .object({
    namespace: z.string().min(1),
    label: z.string().trim().min(1).max(500),
    events: z.array(eventTypeSchema).min(1),
    match: eventMatchSchema.optional(),
  })
  .strict();

export const eventAutomationEditSchema = automationEditFieldsSchema
  .extend({ trigger: eventAutomationTriggerEditSchema.optional() })
  .strict();
