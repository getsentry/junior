import { scheduleIntentSchema } from "@/chat/scheduled-automations/schedule-intent";
import {
  eventAutomationTriggerSchema,
  EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH,
} from "@/chat/event-automations/types";
import { taskOutcomeSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";
import { automationTaskSchema, automationTaskTextSchema } from "./task";

export const automationTitleSchema = z.string().trim().min(1).max(60);

/**
 * Instruction input for agent tools. The run does not see the request, so the
 * instruction names exact targets. It calls the creator "the Automation
 * creator". It names every other person with their mention.
 */
export const automationInstructionToolSchema =
  automationTaskTextSchema.describe(
    'Work to perform when the Automation runs. Say what to do, what to post, and when to post nothing. Do not say where to post: the outcomes set that, a run triggered by a Slack message replies in its thread, and each run ends with one message at most. The run does not see this conversation, so words like "this channel" or "here" will mean nothing then. Where the run reads or changes something, write the exact target, such as a channel mention, a repo, or a link. Call the person who created the Automation "the Automation creator", not "me"; each run knows who that is. Name every other person with their Slack mention, such as <@U123>, including a requester who did not create the Automation. Preserve the user\'s scope, targets, and constraints. Do not add permissions or side effects the user did not request.',
  );

/** Context input for agent tools. It follows the same rules as an instruction. */
export const automationContextToolSchema = automationTaskTextSchema.describe(
  'What a skill run needs beyond the skill, such as a repo, a threshold, or who to tag. Leave out what the skill says. Follow the instruction rules: do not say where to post, write exact targets, call the creator "the Automation creator", and mention others.',
);

export const automationEditFieldsSchema = z.object({
  title: automationTitleSchema.optional(),
  /** Replaces the whole task, so a mode switch drops the other mode's text. */
  task: automationTaskSchema.optional(),
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
