import { z } from "zod";
import { CONVERSATION_KINDS } from "@/chat/spaces/types";
import {
  actorIdentitySchema,
  conversationSummaryReportSchema,
} from "./conversation";

/** Kind of work of one Conversation in a Space. */
export const conversationKindSchema = z.enum(CONVERSATION_KINDS);

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

/**
 * One public Conversation listed in a Space. It is a normal Conversation
 * summary, plus its Space, Brief summary, and kind of work.
 */
export const spaceConversationSchema = conversationSummaryReportSchema
  .extend({
    spaceId: z.string().min(1),
    summary: z.string().nullable(),
    kind: conversationKindSchema.nullable(),
  })
  .strict();

/**
 * Hard facts about a Space, from its public Conversations: repositories,
 * channels, people, and kinds of work. Linked work comes from each
 * Conversation's annotations.
 */
export const spaceFactsSchema = z
  .object({
    repositories: z.array(
      z
        .object({
          name: z.string().min(1),
          url: z.string().min(1),
          conversationCount: z.number().int().positive(),
        })
        .strict(),
    ),
    channels: z.array(
      z
        .object({
          name: z.string().min(1),
          conversationCount: z.number().int().positive(),
        })
        .strict(),
    ),
    participants: z.array(actorIdentitySchema),
    kinds: z.array(
      z
        .object({
          kind: conversationKindSchema,
          conversationCount: z.number().int().positive(),
        })
        .strict(),
    ),
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
    facts: spaceFactsSchema,
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
export type SpaceFacts = z.output<typeof spaceFactsSchema>;
export type ConversationKindReport = z.output<typeof conversationKindSchema>;
export type SpaceDetailReport = z.output<typeof spaceDetailReportSchema>;
