import * as z from "zod";
import type { PluginContext } from "./context";
import type { PluginEgress } from "./tools";

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

/** Host-owned context for reading code changes outside a Turn. */
export interface CodeChangeReadHookContext extends PluginContext {
  /**
   * Provider egress with Junior's system identity. It never uses a user's
   * credentials or starts authorization.
   */
  egress: PluginEgress;
  signal: AbortSignal;
}

/** One code change in a stack, at the commits the provider reports now. */
const codeChangeStackItemSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    /** Description text. Empty when the code change has none. */
    body: z.string(),
    url: z.string().url(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The open code changes in one stack, bottom first, plus the requested code
 * change even when it is closed. One item when not stacked.
 */
export const codeChangeStackSchema = z
  .object({ codeChanges: z.array(codeChangeStackItemSchema).min(1) })
  .strict();
export type CodeChangeStack = z.output<typeof codeChangeStackSchema>;

/** One changed file between two commits. */
const codeChangeFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum(["added", "modified", "removed", "renamed"]),
    /** Unified diff. Missing for binary files and files too large to diff. */
    patch: z.string().optional(),
  })
  .strict();

export const codeChangeDiffSchema = z
  .object({ files: z.array(codeChangeFileSchema) })
  .strict();
export type CodeChangeDiff = z.output<typeof codeChangeDiffSchema>;

/**
 * Read-only access to code changes for host features such as Walkthroughs.
 * A plugin implements all three or none. Return `undefined` when the code
 * change or file does not exist; throw for every other failure.
 */
export interface CodeChangeHooks {
  /** Read the stack that contains one code change. */
  readStack(
    ctx: CodeChangeReadHookContext & { repository: string; number: number },
  ): Promise<CodeChangeStack | undefined>;
  /** Read the files changed between a base commit and a head commit. */
  readDiff(
    ctx: CodeChangeReadHookContext & {
      repository: string;
      baseSha: string;
      headSha: string;
    },
  ): Promise<CodeChangeDiff>;
  /** Read one file's text at a commit. */
  readFile(
    ctx: CodeChangeReadHookContext & {
      repository: string;
      sha: string;
      path: string;
    },
  ): Promise<string | undefined>;
}
