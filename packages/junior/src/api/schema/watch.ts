import { eventMatchSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";

/**
 * One active Watch that a Conversation owns: its own, or one that a child agent
 * below it created.
 *
 * Viewers who cannot see private content get the resource type, event types,
 * and times, but not the label, intent, or match filter.
 */
export const conversationWatchSchema = z
  .object({
    /** Absent when the Conversation itself created the Watch. */
    childAgent: z
      .object({
        conversationId: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    events: z.array(z.string().min(1)).min(1),
    expiresAt: z.string().datetime(),
    /** Set only for a timer Watch. */
    firesAt: z.string().datetime().optional(),
    id: z.string().min(1),
    intent: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    match: eventMatchSchema.optional(),
    namespace: z.string().min(1),
    redacted: z.literal(true).optional(),
    resourceType: z.string().min(1),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.label === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "watch label must be text or explicitly redacted",
      });
    }
    if (data.redacted && (data.intent || data.match)) {
      context.addIssue({
        code: "custom",
        message: "redacted watches must not expose an intent or match",
      });
    }
  });

/** Active Watches that one Conversation owns, oldest first. */
export const conversationWatchesReportSchema = z
  .object({
    conversationId: z.string().min(1),
    watches: z.array(conversationWatchSchema),
  })
  .strict();

export type ConversationWatch = z.infer<typeof conversationWatchSchema>;
export type ConversationWatchesReport = z.infer<
  typeof conversationWatchesReportSchema
>;
