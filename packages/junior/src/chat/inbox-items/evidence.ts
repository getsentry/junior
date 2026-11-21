import * as z from "zod";
import { savedUserInputRequestSchema } from "@/chat/inbox-items/user-input-request";

/**
 * One source that an agent cites for an Inbox item: a link or a
 * Conversation, with a short label and an optional one-line note. A link
 * points outside Junior; a Conversation reference points to work in Junior.
 * The question stores the list, and the dashboard shows it beside the
 * answer choices.
 */
export const inboxItemEvidenceSchema = z
  .object({
    conversationId: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(120),
    note: z.string().min(1).max(200).optional(),
    url: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (entry) =>
      (entry.url === undefined) !== (entry.conversationId === undefined),
    "Evidence has a `url` or a `conversationId`, not both.",
  );

export type InboxItemEvidence = z.output<typeof inboxItemEvidenceSchema>;

/**
 * The question of an Inbox item with the evidence for its answer. Evidence
 * is part of the question, so it is stored in the `request` column.
 */
export const inboxItemRequestSchema = savedUserInputRequestSchema.safeExtend({
  evidence: z.array(inboxItemEvidenceSchema).optional(),
});

export type InboxItemRequest = z.output<typeof inboxItemRequestSchema>;
