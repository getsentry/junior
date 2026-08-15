import { z } from "zod";

const workspaceRepoInputSchema = z
  .object({
    provider: z.string(),
    repo: z.string(),
  })
  .strict();

export const workspaceRepoSchema = z
  .object({
    provider: z.string(),
    repo: z.string(),
    checkoutPath: z.string(),
  })
  .strict();

const workspaceSnapshotSchema = z
  .object({
    id: z.string(),
    generatedAt: z.iso.datetime(),
    buildDurationMs: z.number().int().nonnegative(),
  })
  .strict();

export const workspaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    setupScript: z.string(),
    repos: z.array(workspaceRepoSchema),
    snapshot: workspaceSnapshotSchema.nullable(),
  })
  .strict();

export const workspaceListSchema = z
  .object({ workspaces: z.array(workspaceSchema) })
  .strict();

export const workspaceBodySchema = z
  .object({
    name: z.string(),
    setupScript: z.string().optional(),
    repos: z.array(workspaceRepoInputSchema),
  })
  .strict();

export const workspaceParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const deleteWorkspaceResponseSchema = z
  .object({ deleted: z.literal(true) })
  .strict();

export type WorkspaceReport = z.infer<typeof workspaceSchema>;
