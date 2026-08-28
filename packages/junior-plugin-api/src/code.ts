import { z } from "zod";

export const codeChangeStateSchema = z.enum(["closed", "merged", "open"]);
export type CodeChangeState = z.output<typeof codeChangeStateSchema>;

export const codeChangeInputSchema = z
  .object({
    closedAt: z.date().optional(),
    conversationIds: z.array(z.string().min(1)).default([]),
    mergedAt: z.date().optional(),
    number: z.number().int().positive(),
    openedAt: z.date(),
    providerId: z.string().min(1),
    repository: z
      .object({
        name: z.string().min(1),
        providerId: z.string().min(1),
        url: z.string().url().optional(),
      })
      .strict(),
    state: codeChangeStateSchema,
    title: z.string().min(1).optional(),
    updatedAt: z.date(),
    url: z.string().url().optional(),
  })
  .strict();

export type CodeChangeInput = z.input<typeof codeChangeInputSchema>;

/** Write code changes from a plugin to Junior's code records. */
export interface CodeChangePublisher {
  associateConversations(input: {
    conversationIds: string[];
    providerId: string;
  }): Promise<void>;
  record(input: CodeChangeInput): Promise<void>;
}
