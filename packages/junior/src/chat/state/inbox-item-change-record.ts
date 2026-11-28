import * as z from "zod";

/**
 * The person change to an Inbox item that one message records. Each inbound
 * message and saved Message that reports a take, answer, or dismiss carries
 * its own record, so the dashboard shows what that message did, not what the
 * item looks like now.
 *
 * Stored Messages and queued inputs keep this shape and their
 * `reviewItemChange` and `reviewItemChanges` keys from before Review items
 * became Inbox items, so these names stay.
 */
export const inboxItemChangeRecordSchema = z
  .object({
    kind: z.enum(["submitted", "dismissed", "taken"]),
    reviewItemId: z.string().min(1),
  })
  .strict();

export type InboxItemChangeRecord = z.output<
  typeof inboxItemChangeRecordSchema
>;
