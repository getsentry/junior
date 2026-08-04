import { z } from "zod";

const taskDestinationSchema = z
  .object({
    channelId: z.string().min(1),
    label: z.string().min(1),
    teamId: z.string().min(1),
    visibility: z.enum(["private", "public"]),
  })
  .strict();

const taskSummaryBaseSchema = z.object({
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
  createdByEmail: z.string().trim().email().optional(),
  destination: taskDestinationSchema,
  id: z.string().min(1),
  instruction: z.string().min(1),
  ownedByViewer: z.boolean(),
});

export const scheduledTaskSummarySchema = taskSummaryBaseSchema
  .extend({
    kind: z.literal("scheduled"),
    nextRunAt: z.string().datetime().optional(),
    schedule: z.string().min(1),
    status: z.enum(["active", "blocked"]),
  })
  .strict();

export const eventTaskSummarySchema = taskSummaryBaseSchema
  .extend({
    events: z.array(z.string().min(1)).min(1),
    kind: z.literal("event"),
    resource: z.string().min(1),
    source: z.string().min(1),
    triggerAvailable: z.boolean(),
  })
  .strict();

export const taskSummarySchema = z.discriminatedUnion("kind", [
  scheduledTaskSummarySchema,
  eventTaskSummarySchema,
]);

export const taskListSchema = z
  .object({
    tasks: z.array(taskSummarySchema),
    truncated: z.boolean(),
  })
  .strict();

export const taskParamsSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["scheduled", "event"]),
  })
  .strict();

export type TaskSummary = z.output<typeof taskSummarySchema>;
export type TaskList = z.output<typeof taskListSchema>;
