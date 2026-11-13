import * as z from "zod";

/** Public Slack channel Location that a dashboard Conversation moves to. */
export const continueConversationInSlackBodySchema = z
  .object({ locationId: z.string().min(1) })
  .strict();

/** The Slack thread where the Conversation now continues. */
export const continueConversationInSlackResponseSchema = z
  .object({
    conversationId: z.string().min(1),
    channelName: z.string().min(1).optional(),
    locationUrl: z.string().url().optional(),
  })
  .strict();

export type ContinueConversationInSlackBody = z.infer<
  typeof continueConversationInSlackBodySchema
>;
export type ContinueConversationInSlackResponse = z.infer<
  typeof continueConversationInSlackResponseSchema
>;
