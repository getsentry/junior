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
        url: z.string().url().optional(),
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
    url: z.string().url().optional(),
  })
  .strict();

export type CodeChangeInput = z.input<typeof codeChangeInputSchema>;

export const codeChangeFilterSchema = z
  .object({
    /** Code changes linked to any of these Conversations. */
    conversationIds: z.array(z.string().min(1)).min(1).optional(),
    repository: z
      .object({
        /** The repository name. Junior matches it in any case. */
        name: z.string().min(1),
        numbers: z.array(z.number().int().positive()).min(1).optional(),
      })
      .strict()
      .optional(),
    state: codeChangeStateSchema.optional(),
    /** Code changes whose last update is before this time. */
    updatedBefore: z.date().optional(),
  })
  .strict();

export type CodeChangeFilter = z.input<typeof codeChangeFilterSchema>;

/** A code change of a plugin, as Junior's code records hold it now. */
export interface CodeChange {
  closedAt: Date | undefined;
  conversationIds: string[];
  mergedAt: Date | undefined;
  number: number;
  providerId: string;
  repository: { name: string; providerId: string };
  state: CodeChangeState;
}

/** A plugin's code changes in Junior's code records. */
export interface PluginCodeChanges {
  associateConversations(input: {
    conversationIds: string[];
    providerId: string;
  }): Promise<void>;
  /**
   * List the code changes of this plugin that match every part of the
   * filter, oldest update first, in one read.
   */
  list(filter: CodeChangeFilter): Promise<CodeChange[]>;
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
