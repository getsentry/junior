import type { SlackAdapter } from "@chat-adapter/slack";
import { Message } from "chat";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import type { SlackInteractivePayload } from "./slack-payload";

/**
 * Build the Slack input that a click or form makes in a thread, as a
 * mention from the person who acted. The input has no Slack message of its
 * own, so `messageId` is not a timestamp. Every Slack timestamp reader, such
 * as reactions, the actor `slack_ts`, and attachment lookup, then resolves
 * `raw.ts`: the message that the person clicked. `inputTs` sets the time of
 * the input.
 */
export function buildSlackInteractionInput(args: {
  adapter: SlackAdapter;
  channelId: string;
  inputTs: SlackMessageTs;
  messageId: string;
  messageTs: SlackMessageTs;
  payload: SlackInteractivePayload;
  text: string;
  threadTs: SlackMessageTs;
  userId: string;
}): Message {
  const event = {
    type: "message",
    channel: args.channelId,
    team: args.payload.team?.id,
    text: args.text,
    thread_ts: args.threadTs,
    ts: args.inputTs,
    user: args.userId,
    user_team: args.payload.user?.team_id,
  };
  const parsed = args.adapter.parseMessage(event);
  return new Message({
    attachments: parsed.attachments,
    author: parsed.author,
    formatted: parsed.formatted,
    id: args.messageId,
    isMention: true,
    links: parsed.links,
    metadata: parsed.metadata,
    raw: { ...event, ts: args.messageTs },
    text: parsed.text,
    threadId: parsed.threadId,
  });
}
