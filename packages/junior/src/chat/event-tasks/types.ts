import {
  destinationSchema,
  isSlackDestination,
  resourceEventTypeSchema,
  slackActorSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const slackDestinationSchema = destinationSchema.refine(isSlackDestination);

export const eventTaskPrincipalSchema = z
  .object({
    slackUserId: slackActorSchema.shape.userId,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();

export const eventTaskConversationAccessSchema = z
  .object({
    audience: z.enum(["direct", "group", "channel"]),
    visibility: z.enum(["private", "public", "unknown"]),
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
    conversationAccess: eventTaskConversationAccessSchema,
    createdAtMs: z.number().finite(),
    createdBy: eventTaskPrincipalSchema,
    credentialMode: z.enum(["system", "creator"]),
    destination: slackDestinationSchema,
    status: z.enum(["active", "deleted"]),
    task: z.object({ text: z.string().min(1) }).strict(),
    trigger: eventTaskTriggerSchema,
  })
  .strict();

/** Credential authority used when an event task dispatches. */
export type EventTaskCredentialMode = z.output<
  typeof eventTaskSchema.shape.credentialMode
>;
/** Persisted event task lifecycle; pause and resume are intentionally absent. */
export type EventTaskStatus = z.output<typeof eventTaskSchema.shape.status>;

/** Slack actor who created an event task. */
export type EventTaskPrincipal = z.output<typeof eventTaskPrincipalSchema>;

/** Ingress-confirmed access classification for the task destination. */
export type EventTaskConversationAccess = z.output<
  typeof eventTaskConversationAccessSchema
>;

/** Exact namespace resource and event types that activate an event task. */
export type EventTaskTrigger = z.output<typeof eventTaskTriggerSchema>;

/** Durable instruction dispatched for matching resource events. */
export type EventTask = z.output<typeof eventTaskSchema>;
