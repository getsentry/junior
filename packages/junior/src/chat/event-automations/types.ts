import {
  actorUserIdSchema,
  destinationVisibilitySchema,
  eventMatchSchema,
  eventTypeSchema,
  slackDestinationSchema,
  taskOutcomeSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Keep indexed event-automation selectors within PostgreSQL B-tree entry limits. */
export const EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH = 300;

/** Validate the persisted Slack creator identity for an event automation. */
export const eventAutomationPrincipalSchema = z
  .object({
    slackUserId: actorUserIdSchema,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();

/** Validate one persisted event-automation selector and its presentation metadata. */
const eventAutomationTriggerSchema = z
  .object({
    events: z.array(eventTypeSchema).min(1),
    label: z.string().min(1),
    match: eventMatchSchema.optional(),
    namespace: z.string().min(1),
    identifier: z.string().min(1).max(EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH),
    resourceType: z.string().min(1),
  })
  .strict();

/** Validate one persisted event automation. */
export const eventAutomationSchema = z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().finite(),
    createdBy: eventAutomationPrincipalSchema,
    credentialMode: z.enum(["system", "creator"]),
    destination: slackDestinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    /** Explicit visible effects after successful work. An empty list is silent. */
    outcomes: z.array(taskOutcomeSchema).max(5),
    task: z.object({ text: z.string().min(1) }).strict(),
    trigger: eventAutomationTriggerSchema,
  })
  .strict();

/** Durable instruction dispatched for matching events. */
export type EventAutomation = z.output<typeof eventAutomationSchema> & {
  /**
   * Short display title generated from the task instruction.
   * SQL-backed column; never stored inside the JSON task payload.
   */
  title?: string;
};
