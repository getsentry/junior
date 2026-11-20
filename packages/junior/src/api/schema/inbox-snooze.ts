import * as z from "zod";

/** The Inbox row of a snooze: one Conversation, or one item in it. */
export const inboxSnoozeSubjectSchema = z
  .object({
    conversationId: z.string().min(1),
    reviewItemId: z.string().min(1).optional(),
  })
  .strict();

/**
 * `POST /api/inbox/snoozes` body: hide the row's open items from the viewer
 * until `wakeAt`. A later item in the row shows by itself.
 */
export const inboxSnoozeCreateSchema = inboxSnoozeSubjectSchema
  .extend({ wakeAt: z.string().datetime() })
  .strict();

/** The items that a snooze hid from the viewer, one snooze each. */
export const inboxSnoozeSchema = z
  .object({ reviewItemIds: z.array(z.string().min(1)).min(1) })
  .strict();

export type InboxSnoozeCreateBody = z.input<typeof inboxSnoozeCreateSchema>;
export type InboxSnoozeSubjectBody = z.input<typeof inboxSnoozeSubjectSchema>;
