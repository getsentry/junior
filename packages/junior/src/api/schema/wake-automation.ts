import * as z from "zod";
import {
  wakeSubjectSchema,
  wakeTriggersSchema,
} from "@/chat/wake-automations/types";

/** Create a Snooze: a one-shot wake Automation on one Inbox row. */
export const wakeAutomationCreateSchema = z
  .object({
    action: z.literal("wake"),
    subject: wakeSubjectSchema,
    triggers: wakeTriggersSchema,
  })
  .strict();

/** One Snooze, as the dashboard reads it. */
export const wakeAutomationSchema = z
  .object({
    action: z.literal("wake"),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
    status: z.enum(["active", "completed"]),
    subject: wakeSubjectSchema,
    triggers: wakeTriggersSchema,
  })
  .strict();

/**
 * The viewer's Snoozes that hide an Inbox row now, newest first. `title` is
 * the snoozed item's, or the Conversation's when it has one.
 */
export const wakeAutomationListSchema = z
  .object({
    snoozes: z.array(
      wakeAutomationSchema.extend({ title: z.string().min(1).optional() }),
    ),
  })
  .strict();

export type WakeAutomationCreateBody = z.input<
  typeof wakeAutomationCreateSchema
>;
export type WakeAutomationPayload = z.output<
  typeof wakeAutomationListSchema
>["snoozes"][number];
