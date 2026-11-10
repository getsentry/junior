import * as z from "zod";
import { walkthroughDocumentSchema } from "@/chat/walkthroughs/schema";

/** One reviewer's answer to one decision, on the version they saw. */
export const walkthroughAnswerSchema = z
  .object({
    versionId: z.string().min(1),
    decisionId: z.string().min(1),
    value: z.enum(["accept", "change"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/** A Walkthrough version and the viewer's own review state. */
export const walkthroughReportSchema = z
  .object({
    document: walkthroughDocumentSchema,
    answers: z.array(walkthroughAnswerSchema),
    /**
     * The Conversation that made the PR. The server sets it only when the
     * viewer may read that Conversation, so a private one stays unknown.
     */
    source: z
      .object({
        conversationId: z.string().min(1),
        title: z.string().min(1),
      })
      .strict()
      .optional(),
    /** The last version this viewer finished. Undefined on a first review. */
    seenVersionId: z.string().min(1).optional(),
  })
  .strict();

export type WalkthroughAnswer = z.infer<typeof walkthroughAnswerSchema>;
export type WalkthroughReport = z.infer<typeof walkthroughReportSchema>;
