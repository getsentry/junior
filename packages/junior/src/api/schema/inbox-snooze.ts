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
const wakeAt = { wakeAt: z.string().datetime() };

/**
 * The Inbox row of a snooze: one Conversation, one item in it, or one item
 * on its own.
 */
export const inboxSnoozeSubjectSchema = z.union([
  conversationRowSchema,
  itemRowSchema,
]);

/**
 * `POST /api/inbox/snoozes` body: hide the row's open items from the viewer
 * until `wakeAt`. A later item in the row shows by itself.
 */
export const inboxSnoozeCreateSchema = z.union([
  conversationRowSchema.extend(wakeAt).strict(),
  itemRowSchema.extend(wakeAt).strict(),
]);

/** The items that a snooze hid from the viewer, one snooze each. */
export const inboxSnoozeSchema = z
  .object({ reviewItemIds: z.array(z.string().min(1)).min(1) })
  .strict();

export type InboxSnoozeCreateBody = z.input<typeof inboxSnoozeCreateSchema>;
export type InboxSnoozeSubjectBody = z.input<typeof inboxSnoozeSubjectSchema>;
