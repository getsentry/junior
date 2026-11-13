import { eventMatchSchema, eventTypeSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { CORE_EVENT_NAMESPACE } from "@/chat/events/catalog";
import { EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH } from "@/chat/event-automations/types";

/** Event type of the timer that a wake Automation can carry. */
export const WAKE_TIMER_EVENT_TYPE = "timer.fired";

/**
 * A timer Event: `timer.fired` for this wake Automation's own timer, at
 * `firesAt`. Its identifier is `automation:<id>`, so no Watch or other
 * Automation can select it, and the wake is its only consumer.
 */
const wakeTimerTriggerSchema = z
  .object({
    kind: z.literal("event"),
    namespace: z.literal(CORE_EVENT_NAMESPACE),
    resourceType: z.literal("timer"),
    events: z.tuple([z.literal(WAKE_TIMER_EVENT_TYPE)]),
    firesAt: z.string().datetime(),
  })
  .strict();

/**
 * Any other catalog Event, selected like an event Automation trigger: one
 * resource with a resource type and an identifier, or every resource of the
 * namespace that its filters match.
 */
const wakeEventTriggerSchema = z
  .object({
    kind: z.literal("event"),
    namespace: z.string().min(1),
    resourceType: z.string().min(1).optional(),
    identifier: z
      .string()
      .min(1)
      .max(EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH)
      .optional(),
    events: z.array(eventTypeSchema).min(1),
    match: eventMatchSchema.optional(),
    /** Short text for the snooze, such as "Until reviewed". */
    label: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (trigger) =>
      (trigger.identifier === undefined) ===
      (trigger.resourceType === undefined),
    {
      message:
        "Set both a resource type and an identifier, or leave out both to wake for every resource.",
      path: ["identifier"],
    },
  )
  .refine(
    (trigger) =>
      !(
        trigger.namespace === CORE_EVENT_NAMESPACE &&
        trigger.resourceType === "timer"
      ),
    { message: "A timer Event needs `firesAt`.", path: ["firesAt"] },
  );

/** A new Review item in the subject Conversation. Every wake has it. */
const newItemTriggerSchema = z.object({ kind: z.literal("new_item") }).strict();

/** Validate one wake trigger. Every trigger is an Event or `new_item`. */
const wakeTriggerSchema = z.union([
  wakeTimerTriggerSchema,
  wakeEventTriggerSchema,
  newItemTriggerSchema,
]);

export type WakeTrigger = z.output<typeof wakeTriggerSchema>;
type WakeTimerTrigger = z.output<typeof wakeTimerTriggerSchema>;
type WakeEventTrigger = z.output<typeof wakeEventTriggerSchema>;

/** Return the timer trigger of a wake, if it has one. */
export function wakeTimerTrigger(
  triggers: readonly WakeTrigger[],
): WakeTimerTrigger | undefined {
  return triggers.find(
    (trigger): trigger is WakeTimerTrigger => "firesAt" in trigger,
  );
}

/** Return the non-timer Event trigger of a wake, if it has one. */
export function wakeEventTrigger(
  triggers: readonly WakeTrigger[],
): WakeEventTrigger | undefined {
  return triggers.find(
    (trigger): trigger is WakeEventTrigger =>
      trigger.kind === "event" && !("firesAt" in trigger),
  );
}

/**
 * v1 allows one timer Event, one other Event, and `new_item`, which every
 * wake has. The first trigger to fire wins.
 */
export const wakeTriggersSchema = z
  .array(wakeTriggerSchema)
  .min(1)
  .max(3)
  .superRefine((triggers, ctx) => {
    const timers = triggers.filter((trigger) => "firesAt" in trigger);
    const events = triggers.filter(
      (trigger) => trigger.kind === "event" && !("firesAt" in trigger),
    );
    const newItems = triggers.filter((trigger) => trigger.kind === "new_item");
    if (timers.length > 1 || events.length > 1 || newItems.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A snooze has `new_item`, at most one timer Event, and at most one other Event.",
      });
    }
  });

/** The Inbox row that a wake hides: one Conversation, or one item in it. */
export const wakeSubjectSchema = z
  .object({
    conversationId: z.string().min(1),
    reviewItemId: z.string().min(1).optional(),
  })
  .strict();

export type WakeSubject = z.output<typeof wakeSubjectSchema>;

/**
 * The `record` of a wake Automation row. `action` is only `wake` today.
 * Planned members: `wake_run` (wake, then run an instruction or an existing
 * Automation by id on the row), and a `run` that continues in its subject
 * Conversation, allowed in any Conversation its creator can see. Neither
 * exists yet.
 */
export const wakeAutomationRecordSchema = z
  .object({
    action: z.literal("wake"),
    subject: wakeSubjectSchema,
    triggers: wakeTriggersSchema,
  })
  .strict();

export type WakeAutomationRecord = z.output<typeof wakeAutomationRecordSchema>;

/** A stored wake Automation: a Snooze. */
export type WakeAutomation = WakeAutomationRecord & {
  createdAtMs: number;
  creatorIdentityId: string;
  id: string;
  status: "active" | "completed";
  /** Why it woke, such as `timer.fired`, `new_item` or `unsnoozed`. */
  statusReason?: string;
};
