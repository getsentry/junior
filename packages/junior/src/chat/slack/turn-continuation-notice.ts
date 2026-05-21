import { buildTurnContinuationResponse } from "@/chat/services/turn-continuation-response";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
  type SlackMessageBlock,
} from "@/chat/slack/footer";

/** Build the Slack timeout-continuation acknowledgement with correlation-only metadata. */
export function buildSlackTurnContinuationNotice(args: {
  conversationId?: string;
}): {
  blocks?: SlackMessageBlock[];
  text: string;
} {
  const text = buildTurnContinuationResponse();
  const footer = buildSlackReplyFooter({
    conversationId: args.conversationId,
  });
  const blocks = footer ? buildSlackReplyBlocks(text, footer) : undefined;
  return {
    text,
    ...(blocks ? { blocks } : {}),
  };
}
