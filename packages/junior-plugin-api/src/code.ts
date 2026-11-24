import * as z from "zod";
import { codeChangeSizeSchema } from "./object-facts";

export const codeChangeStateSchema = z.enum(["closed", "merged", "open"]);
export type CodeChangeState = z.output<typeof codeChangeStateSchema>;

export const codeChangeInputSchema = z
  .object({
    closedAt: z.date().optional(),
    conversationIds: z.array(z.string().min(1)).default([]),
    /**
     * Whether the code change is a draft. When omitted, Junior keeps the
     * stored value; a new code change is not a draft.
     */
    draft: z.boolean().optional(),
    mergedAt: z.date().optional(),
    number: z.number().int().positive(),
    openedAt: z.date(),
    providerId: z.string().min(1),
    repository: z
      .object({
        name: z.string().min(1),
        providerId: z.string().min(1),
      })
      .strict(),
    /**
     * The size as the provider counts it now. Junior keeps the stored value
     * of each part that is omitted.
     */
    size: codeChangeSizeSchema.optional(),
    state: codeChangeStateSchema,
    title: z.string().min(1).optional(),
    updatedAt: z.date(),
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
  /**
   * Record a push, review, or comment by a person on a code change. Junior
   * ignores activity on code changes that it did not record.
   */
  recordActivity(input: {
    at: Date;
    number: number;
    repositoryProviderId: string;
  }): Promise<void>;
}

/**
 * Build the web pages of a code plugin's repositories and code changes from
 * the repository name and the code change number, so Junior does not store
 * them.
 */
export interface PluginCodeLinks {
  change(input: { number: number; repository: string }): string;
  /** Read the repository and number of a code change's web page. */
  parseChange(url: string): { number: number; repository: string } | undefined;
  repository(name: string): string;
}
