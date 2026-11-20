import * as z from "zod";

const conversationRowSchema = z
  .object({
    conversationId: z.string().min(1),
    reviewItemId: z.string().min(1).optional(),
  })
  .strict();
// An item whose owner is not a Conversation, such as an Automation alert,
// has a row of its own.
const itemRowSchema = z.object({ reviewItemId: z.string().min(1) }).strict();

/**
 * The Inbox row of a snooze: one Conversation, one item in it, or one item
 * on its own.
 */
export const inboxSnoozeSubjectSchema = z.union([
  conversationRowSchema,
  itemRowSchema,
]);

/**
 * An Event on an item's subject resource that ends its snooze: `wake`
 * shows the item again, and `resolve` dismisses it. The subject of each
 * item names the resource, so the request names only the Event type.
 */
export const inboxSnoozeTriggerSchema = z
  .object({
    eventType: z.string().min(1),
    outcome: z.enum(["wake", "resolve"]),
  })
  .strict();

const snoozeUntil = {
  // Bound the trigger rows that one request writes for each item.
  triggers: z.array(inboxSnoozeTriggerSchema).min(1).max(10).optional(),
  wakeAt: z.string().datetime().optional(),
};

/**
 * `POST /api/inbox/snoozes` body: hide the row's open items from the viewer
 * until `wakeAt` or one of `triggers` fires, whichever is first. A later
 * item in the row shows by itself.
 */
export const inboxSnoozeCreateSchema = z
  .union([
    conversationRowSchema.extend(snoozeUntil).strict(),
    itemRowSchema.extend(snoozeUntil).strict(),
  ])
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
