import * as z from "zod";
import { walkthroughDocumentSchema } from "@/chat/walkthroughs/schema";

/** Request body that starts a Walkthrough of the stack around one code change. */
export const startWalkthroughBodySchema = z
  .object({
    provider: z.string().min(1),
    repository: z.string().min(1),
    number: z.number().int().positive(),
  })
  .strict();

export const walkthroughParamsSchema = z.object({ id: z.uuid() }).strict();

/** One Walkthrough version, with its document when it is ready. */
export const walkthroughVersionSchema = z
  .object({
    id: z.string(),
    status: z.enum(["generating", "ready", "failed"]),
    provider: z.string(),
    repository: z.string(),
    codeChanges: z.array(
      z
        .object({
          number: z.number().int().positive(),
          title: z.string(),
          url: z.string(),
          headSha: z.string(),
          baseSha: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    /** What the generation has cost so far. */
    costUsd: z.number().nonnegative().optional(),
    failureReason: z.string().optional(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
    document: walkthroughDocumentSchema.optional(),
  })
  .strict();
export type WalkthroughVersionResponse = z.output<
  typeof walkthroughVersionSchema
>;
