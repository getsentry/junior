import {
  destinationVisibilitySchema,
  resourceEventTypeSchema,
  slackActorSchema,
  slackDestinationSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const eventTaskPrincipalSchema = z
  .object({
    slackUserId: slackActorSchema.shape.userId,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();

export const eventTaskTriggerSchema = z
  .object({
    events: z.array(resourceEventTypeSchema).min(1),
    label: z.string().min(1),
    namespace: z.string().min(1),
    identifier: z.string().min(1),
    resourceType: z.string().min(1),
  })
  .strict();

export const eventTaskSchema = z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().finite(),
    createdBy: eventTaskPrincipalSchema,
    credentialMode: z.enum(["system", "creator"]),
    destination: slackDestinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    task: z.object({ text: z.string().min(1) }).strict(),
    trigger: eventTaskTriggerSchema,
  })
  .strict();

/** Slack actor who created an event task. */
export type EventTaskPrincipal = z.output<typeof eventTaskPrincipalSchema>;

/** Durable instruction dispatched for matching resource events. */
export type EventTask = z.output<typeof eventTaskSchema>;
