import * as z from "zod";
import { userInputRequestSchema } from "@/chat/review-items/user-input-request";

/**
 * One source that an agent cites for a Review item: a link or a
 * Conversation, with a short label and an optional one-line note. A link
 * points outside Junior; a Conversation reference points to work in Junior.
 * The question stores the list, and the dashboard shows it beside the
 * answer choices.
 */
export const reviewItemEvidenceSchema = z
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

export type ReviewItemEvidence = z.output<typeof reviewItemEvidenceSchema>;

/**
 * The question of a Review item with the evidence for its answer. Evidence
 * is part of the question, so it is stored in the `request` column.
 */
export const reviewItemRequestSchema = userInputRequestSchema.safeExtend({
  evidence: z.array(reviewItemEvidenceSchema).optional(),
});

export type ReviewItemRequest = z.output<typeof reviewItemRequestSchema>;
