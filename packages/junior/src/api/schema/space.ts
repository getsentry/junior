import { z } from "zod";

/** One active Space in dashboard reports. */
export const spaceSummarySchema = z
  .object({
    spaceId: z.string().min(1),
    parentSpaceId: z.string().min(1).nullable(),
    name: z.string().min(1),
    description: z.string(),
    path: z.array(z.string().min(1)).min(1),
    childCount: z.number().int().nonnegative(),
    conversationCount: z.number().int().nonnegative(),
    totalConversationCount: z.number().int().nonnegative(),
    lastActivityAt: z.iso.datetime().nullable(),
  })
  .strict();

/** Every active Space, parents before children, in display order. */
export const spaceTreeReportSchema = z
  .object({
    spaces: z.array(spaceSummarySchema),
  })
  .strict();

/** One public Conversation listed in a Space. */
export const spaceConversationSchema = z
  .object({
    conversationId: z.string().min(1),
    spaceId: z.string().min(1),
    title: z.string().nullable(),
    channelName: z.string().nullable(),
    summary: z.string().nullable(),
    lastActivityAt: z.iso.datetime(),
  })
  .strict();

/** One Space with breadcrumbs, child Spaces, and recent Conversations. */
export const spaceDetailReportSchema = z
  .object({
    space: spaceSummarySchema,
    breadcrumbs: z.array(
      z
        .object({ spaceId: z.string().min(1), name: z.string().min(1) })
        .strict(),
    ),
    children: z.array(spaceSummarySchema),
    conversations: z.array(spaceConversationSchema),
    /** Private Conversations in this subtree. They are counted, never listed. */
    privateConversationCount: z.number().int().nonnegative(),
  })
  .strict();

export const spaceParamsSchema = z
  .object({ spaceId: z.string().trim().min(1).max(64) })
  .strict();

export type SpaceSummary = z.output<typeof spaceSummarySchema>;
export type SpaceTreeReport = z.output<typeof spaceTreeReportSchema>;
export type SpaceConversation = z.output<typeof spaceConversationSchema>;
export type SpaceDetailReport = z.output<typeof spaceDetailReportSchema>;
