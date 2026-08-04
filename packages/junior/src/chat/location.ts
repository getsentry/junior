import {
  nonBlankStringSchema,
  slackDestinationSchema,
  sourceVisibilitySchema,
  type Destination,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { SessionSource } from "@/chat/source";

export const locationSchema = slackDestinationSchema
  .omit({ platform: true })
  .extend({
    provider: z.literal("slack"),
    threadTs: nonBlankStringSchema,
    visibility: sourceVisibilitySchema,
  })
  .strict();

export type Location = z.output<typeof locationSchema>;

/** Build one stable provider location from persisted conversation routing. */
export function locationFromConversation(args: {
  destination?: Destination;
  source?: SessionSource;
  visibility?: ConversationPrivacy;
}): Location | undefined {
  const { destination, source } = args;
  // Local origins have no provider location. Scheduled/plugin dispatch can keep a
  // local sessionSource while delivering to a Slack destination.
  if (!source || source.platform === "local") {
    return undefined;
  }
  if (destination?.platform === "local") {
    throw new Error("Conversation location platform is inconsistent");
  }
  if (
    destination?.platform === "slack" &&
    (destination.teamId !== source.teamId ||
      destination.channelId !== source.channelId)
  ) {
    throw new Error("Conversation Slack location is inconsistent");
  }
  return locationSchema.parse({
    provider: "slack",
    teamId: source.teamId,
    channelId: source.channelId,
    threadTs: source.threadTs,
    visibility: args.visibility ?? source.visibility,
  });
}
