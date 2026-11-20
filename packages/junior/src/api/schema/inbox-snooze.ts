import * as z from "zod";

/** The Inbox row of a snooze: one Conversation, or one item in it. */
export const inboxSnoozeSubjectSchema = z
  .object({
    conversationId: z.string().min(1),
    reviewItemId: z.string().min(1).optional(),
  })
  .strict();

/**
 * An Event that ends a snooze: `wake` shows the item again, and `resolve`
 * dismisses it. The Event is on the page at `resourceUrl`, such as another
 * pull request, or on each item's subject when it is unset.
 */
export const inboxSnoozeTriggerSchema = z
  .object({
    eventType: z.string().min(1),
    outcome: z.enum(["wake", "resolve"]),
    resourceUrl: z.string().url().max(2000).optional(),
  })
  .strict();

/**
 * An Event resource that a snooze can wait on, such as a pull request, and
 * the Event types of its resource type.
 */
export const inboxSnoozeResourceSchema = z
  .object({
    events: z.array(z.string().min(1)).min(1),
    namespace: z.string().min(1),
    /** How each Event reads after the resource's name, such as "is merged". */
    phrases: z.record(z.string().min(1), z.string().min(1)),
    resourceType: z.string().min(1),
  })
  .strict();

/** `GET /api/inbox/snoozes/resource` query: the page that a person names. */
export const inboxSnoozeResourceQuerySchema = z
  .object({ url: z.string().url().max(2000) })
  .strict();

/**
 * `POST /api/inbox/snoozes` body: hide the row's open items from the viewer
 * until `wakeAt` or one of `triggers` fires, whichever is first. A later
 * item in the row shows by itself.
 */
export const inboxSnoozeCreateSchema = inboxSnoozeSubjectSchema
  .extend({
    // Bound the trigger rows that one request writes for each item.
    triggers: z.array(inboxSnoozeTriggerSchema).min(1).max(10).optional(),
    wakeAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((body) => body.wakeAt !== undefined || body.triggers !== undefined, {
    message: "Set wakeAt, triggers, or both.",
  });

/** The items that a snooze hid from the viewer, one snooze each. */
export const inboxSnoozeSchema = z
  .object({ reviewItemIds: z.array(z.string().min(1)).min(1) })
  .strict();

export type InboxSnoozeCreateBody = z.input<typeof inboxSnoozeCreateSchema>;
export type InboxSnoozeSubjectBody = z.input<typeof inboxSnoozeSubjectSchema>;
export type InboxSnoozeTrigger = z.output<typeof inboxSnoozeTriggerSchema>;
export type InboxSnoozeResource = z.output<typeof inboxSnoozeResourceSchema>;
