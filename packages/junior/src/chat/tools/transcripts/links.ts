import type { ConversationMessage } from "@/chat/state/conversation";
import type { TranscriptAccess } from "@/chat/tools/transcripts/access";
import type { TranscriptToolResolvedDeps } from "@/chat/tools/transcripts/deps";

function slackThreadTsFromConversationId(
  conversationId: string,
): string | undefined {
  const match = /^slack:[^:]+:(.+)$/.exec(conversationId);
  return match?.[1];
}

/** Resolve a best-effort source link for one retained transcript message. */
export async function linkForMessage(args: {
  access: TranscriptAccess;
  deps: TranscriptToolResolvedDeps;
  includeLinks: boolean;
  message: ConversationMessage;
}): Promise<string | undefined> {
  if (!args.includeLinks || !args.access.slackChannelId) {
    return undefined;
  }
  const fallbackTs = slackThreadTsFromConversationId(
    args.access.conversation.conversationId,
  );
  const messageTs = args.message.meta?.slackTs ?? fallbackTs;
  if (!messageTs) {
    return undefined;
  }
  return await args.deps.getSlackLink({
    channelId: args.access.slackChannelId,
    messageTs,
  });
}

/** Resolve a best-effort source link for one visible transcript conversation. */
export async function linkForConversation(args: {
  access: TranscriptAccess;
  deps: TranscriptToolResolvedDeps;
  includeLinks: boolean;
}): Promise<string | undefined> {
  if (!args.includeLinks || !args.access.slackChannelId) {
    return undefined;
  }
  const threadTs = slackThreadTsFromConversationId(
    args.access.conversation.conversationId,
  );
  if (!threadTs) {
    return undefined;
  }
  return await args.deps.getSlackLink({
    channelId: args.access.slackChannelId,
    messageTs: threadTs,
  });
}
