import { z } from "zod";

/**
 * The person change to a Review item that one message records. Each inbound
 * message and saved Message that reports a take, answer, or dismiss carries
 * its own record, so the dashboard shows what that message did, not what the
 * item looks like now.
 */
export const reviewItemChangeRecordSchema = z
  .object({
    kind: z.enum(["submitted", "dismissed", "taken"]),
    reviewItemId: z.string().min(1),
  })
  .strict();

export type ReviewItemChangeRecord = z.output<
  typeof reviewItemChangeRecordSchema
>;
