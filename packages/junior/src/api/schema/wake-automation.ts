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
