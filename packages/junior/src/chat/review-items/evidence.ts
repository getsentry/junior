import * as z from "zod";

/**
 * One source that an agent cites for a Review item: a link or a
 * Conversation, with a short label and an optional one-line note. A link
 * points outside Junior; a Conversation reference points to work in Junior.
 * The item stores the list, and the dashboard shows it beside the question.
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
