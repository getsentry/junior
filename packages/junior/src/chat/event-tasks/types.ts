import {
  destinationVisibilitySchema,
  resourceEventTypeSchema,
  slackActorSchema,
  slackDestinationSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Keep indexed event-task selectors within PostgreSQL B-tree entry limits. */
export const EVENT_TASK_IDENTIFIER_MAX_LENGTH = 300;

/** Validate the persisted Slack creator identity for an event task. */
export const eventTaskPrincipalSchema = z
  .object({
    slackUserId: slackActorSchema.shape.userId,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();

/** Validate one persisted event-task selector and its presentation metadata. */
const eventTaskTriggerSchema = z
  .object({
    events: z.array(resourceEventTypeSchema).min(1),
    label: z.string().min(1),
    namespace: z.string().min(1),
    identifier: z.string().min(1).max(EVENT_TASK_IDENTIFIER_MAX_LENGTH),
    resourceType: z.string().min(1),
  })
  .strict();

/** Validate one persisted event task. */
export const eventTaskSchema = z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().finite(),
    createdBy: eventTaskPrincipalSchema,
    credentialMode: z.enum(["system", "creator"]),
    destination: slackDestinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    task: z.object({ text: z.string().min(1) }).strict(),
    /** Short display title generated from the task instruction. */
    title: z.string().min(1).max(60).optional(),
    trigger: eventTaskTriggerSchema,
  })
  .strict();

/** Durable instruction dispatched for matching resource events. */
export type EventTask = z.output<typeof eventTaskSchema>;
