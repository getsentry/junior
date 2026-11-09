import type { SlackAdapter } from "@chat-adapter/slack";
import { ThreadImpl, type Message, type StateAdapter } from "chat";
import { pauseConversationDelivery } from "@/chat/conversations/delivery-pause";
import { saveSkippedSlackMessage } from "./slack-skipped-message";

/** Acknowledge a Slack detach. */
export const SLACK_DETACH_ACK =
  "Detached. Updates stay in the web until someone tags me here.";

/** `!detach` may appear anywhere in the message. */
const BANG_DETACH_RE = /(?:^|\s)!detach(?=\s|$|[.!?,;:])/i;

/** True when a Slack message asks Junior to detach from its thread. */
export function isSlackDetachCommand(text: string): boolean {
  return BANG_DETACH_RE.test(text);
}

/**
 * Pause Delivery of the thread's Event Turn replies to Slack. Work keeps
 * running and its replies stay in the web. The next mention resumes it. Slack
 * sends a mention as both `message` and `app_mention`, so only the delivery
 * that paused it posts the ack.
 */
export async function handleSlackDetach(args: {
  adapter: SlackAdapter;
  canonicalThreadId: string;
  conversationId: string;
  message: Message;
  state: StateAdapter;
}): Promise<void> {
  await saveSkippedSlackMessage({
    conversationId: args.conversationId,
    message: args.message,
    skippedReason: "detach",
  });
  if (!(await pauseConversationDelivery(args.conversationId))) return;
  const thread = new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: args.canonicalThreadId,
    channelId: args.adapter.channelIdFromThreadId(args.canonicalThreadId),
    isDM: args.adapter.isDM(args.canonicalThreadId),
  });
  await thread.post(SLACK_DETACH_ACK);
}
