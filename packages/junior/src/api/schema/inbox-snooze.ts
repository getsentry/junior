import * as z from "zod";

/** The Inbox row of a snooze: one Conversation, or one item in it. */
export const inboxSnoozeSubjectSchema = z
  .object({
    conversationId: z.string().min(1),
    reviewItemId: z.string().min(1).optional(),
  })
  .strict();

/**
 * `POST /api/inbox/snoozes` body: hide the row from the viewer until
 * `wakeAt`, or until a new item in its Conversation.
 */
export const inboxSnoozeCreateSchema = inboxSnoozeSubjectSchema
  .extend({ wakeAt: z.string().datetime() })
  .strict();

/** One snooze of the viewer. */
export const inboxSnoozeSchema = inboxSnoozeSubjectSchema
  .extend({
    createdAt: z.string().datetime(),
    id: z.string().min(1),
    wakeAt: z.string().datetime(),
  })
  .strict();

export type InboxSnoozeCreateBody = z.input<typeof inboxSnoozeCreateSchema>;
export type InboxSnoozeSubjectBody = z.input<typeof inboxSnoozeSubjectSchema>;
