import * as z from "zod";

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
      })
      .strict(),
    state: codeChangeStateSchema,
    title: z.string().min(1).optional(),
    updatedAt: z.date(),
  })
  .strict();

export type CodeChangeInput = z.input<typeof codeChangeInputSchema>;

export const codeRepositoryInputSchema = z
  .object({
    name: z.string().min(1),
    providerId: z.string().min(1),
    /** When the provider had this name. */
    updatedAt: z.date(),
  })
  .strict();

export type CodeRepositoryInput = z.input<typeof codeRepositoryInputSchema>;

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
   * Credit people as requesters of an existing code change: the person Work
   * owners of the Turns that opened or changed it. They add to the stored
   * ones, and a person's code changes include the ones that credit them.
   */
  associateRequesters(input: {
    identityIds: string[];
    providerId: string;
  }): Promise<void>;
  /**
   * List the code changes of this plugin that match every part of the
   * filter, oldest update first, in one read.
   */
  list(filter: CodeChangeFilter): Promise<CodeChange[]>;
  record(input: CodeChangeInput): Promise<void>;
  /**
   * Record the name of a repository that this plugin's code changes are in.
   * An older update does not move the name back.
   */
  recordRepository(input: CodeRepositoryInput): Promise<void>;
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
  repository(name: string): string;
}
