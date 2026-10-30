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

/**
 * Validate one persisted event-automation selector and its presentation
 * metadata. A trigger names one resource with a resource type and an
 * identifier, or it names neither. With neither, it runs for every resource
 * of the namespace that its filters match.
 */
export const eventAutomationTriggerSchema = z
  .object({
    events: z.array(eventTypeSchema).min(1),
    label: z.string().min(1),
    match: eventMatchSchema.optional(),
    namespace: z.string().min(1),
    identifier: z
      .string()
      .min(1)
      .max(EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH)
      .optional(),
    resourceType: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (trigger) =>
      (trigger.identifier === undefined) ===
      (trigger.resourceType === undefined),
    {
      message:
        "Set both a resource type and an identifier, or leave out both to run for every resource.",
      path: ["identifier"],
    },
  );

/** Event automations target a Slack channel or DM, never a message thread. */
const eventAutomationDestinationSchema = slackDestinationSchema.omit({
  threadTs: true,
});

const eventAutomationOutcomeSchema = taskOutcomeSchema.extend({
  destination: eventAutomationDestinationSchema,
});

/** Validate one persisted event automation. */
export const eventAutomationSchema = z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().finite(),
    createdBy: eventAutomationPrincipalSchema,
    /** Junior identity that created the automation. It decides ownership. */
    creatorIdentityId: z.string().min(1),
    credentialMode: z.enum(["system", "creator"]),
    destination: eventAutomationDestinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    /** Explicit visible effects after successful work. An empty list is silent. */
    outcomes: z.array(eventAutomationOutcomeSchema).max(5),
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

/** The part of an event automation that has no SQL column of its own. */
export type EventAutomationRecord = Omit<
  EventAutomation,
  "createdAtMs" | "creatorIdentityId" | "id" | "title"
>;

/**
 * Lifecycle status for one retained event automation. A blocked automation
 * stops matching until its creator resumes it.
 */
export type EventAutomationStatus = "active" | "blocked" | "paused" | "deleted";
